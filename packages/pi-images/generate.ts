import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";

export type GeneratedImage = { data: string; mimeType: string };

export type GenerateOptions = {
    provider: string;
    id: string;
    api: string;
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string | null>;
    prompt: string;
    size?: string;
    images: ImageContent[];
    signal?: AbortSignal;
};

const INPUT_MIME: Record<string, string> = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

export function imageKey(block: ImageContent): string {
    return createHash("sha256").update(`${block.mimeType}\n${block.data}`).digest("hex");
}

export function splitModel(value: string): { provider: string; id: string } {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Model "${value}" must be "provider/model-id"`);
    }
    return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

async function post(
    url: string,
    headers: Record<string, string>,
    body: string | FormData,
    signal?: AbortSignal,
): Promise<any> {
    const response = await fetch(url, { method: "POST", headers, body, signal: signal ?? null });
    if (!response.ok) {
        throw new Error(`Image request failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
    }
    return response.json();
}

function authHeaders(options: GenerateOptions, google = false): Record<string, string> {
    const headers: Record<string, string> = {};
    // Google authenticates with x-goog-api-key; a Bearer key would be rejected.
    if (options.apiKey)
        headers[google ? "x-goog-api-key" : "Authorization"] = google ? options.apiKey : `Bearer ${options.apiKey}`;
    for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (typeof value === "string") headers[key] = value;
    }
    return headers;
}

export async function generateImages(options: GenerateOptions): Promise<GeneratedImage[]> {
    // OpenRouter has no /images/generations endpoint under any base; image generation only works through chat/completions with modalities, hence the fixed URL.
    if (options.provider === "openrouter") return openrouterImages(options);
    if (options.api === "google-generative-ai") return googleImages(options);
    return openaiImages(options);
}

// OpenAI Images API: {baseUrl}/images/generations for text-to-image, {baseUrl}/images/edits with input images.
async function openaiImages(options: GenerateOptions): Promise<GeneratedImage[]> {
    const headers = authHeaders(options);
    let json: any;
    if (options.images.length === 0) {
        json = await post(
            `${options.baseUrl}/images/generations`,
            { ...headers, "Content-Type": "application/json" },
            JSON.stringify({
                model: options.id,
                prompt: options.prompt,
                n: 1,
                ...(options.size ? { size: options.size } : {}),
            }),
            options.signal,
        );
    } else {
        const form = new FormData();
        form.append("model", options.id);
        form.append("prompt", options.prompt);
        form.append("n", "1");
        if (options.size) form.append("size", options.size);
        for (const [index, image] of options.images.entries()) {
            const blob = new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType });
            form.append(index === 0 ? "image" : "image[]", blob, `image-${index}.${extFor(image.mimeType)}`);
        }
        json = await post(`${options.baseUrl}/images/edits`, headers, form, options.signal);
    }
    return openaiOutput(json, options.signal);
}

async function openaiOutput(json: any, signal?: AbortSignal): Promise<GeneratedImage[]> {
    const images: GeneratedImage[] = [];
    for (const item of json?.data ?? []) {
        if (typeof item?.b64_json === "string" && item.b64_json)
            images.push({ data: item.b64_json, mimeType: "image/png" });
        else if (typeof item?.url === "string" && item.url) images.push(await download(item.url, signal));
    }
    if (images.length === 0) throw new Error(`Image API returned no images: ${JSON.stringify(json).slice(0, 300)}`);
    return images;
}

async function googleImages(options: GenerateOptions): Promise<GeneratedImage[]> {
    const headers = { "Content-Type": "application/json", ...authHeaders(options, true) };
    // shortcut: Google has no pixel "size" knob; a size hint is dropped instead of being mapped to imageConfig.
    const body = {
        contents: [
            {
                role: "user",
                parts: [
                    ...options.images.map((image) => ({
                        inline_data: { mime_type: image.mimeType, data: image.data },
                    })),
                    { text: options.prompt },
                ],
            },
        ],
        generationConfig: { responseModalities: ["IMAGE"] },
    };
    const json: any = await post(
        `${options.baseUrl}/models/${encodeURIComponent(options.id)}:generateContent`,
        headers,
        JSON.stringify(body),
        options.signal,
    );
    const images: GeneratedImage[] = [];
    for (const candidate of json?.candidates ?? []) {
        for (const part of candidate?.content?.parts ?? []) {
            // The REST API returns camelCase inlineData; the proto form is inline_data.
            const inline = part?.inlineData ?? part?.inline_data;
            if (typeof inline?.data === "string" && inline.data) {
                images.push({ data: inline.data, mimeType: inline.mimeType ?? inline.mime_type ?? "image/png" });
            }
        }
    }
    if (images.length === 0) throw new Error(`Google returned no image data: ${JSON.stringify(json).slice(0, 300)}`);
    return images;
}

async function openrouterImages(options: GenerateOptions): Promise<GeneratedImage[]> {
    const json: any = await post(
        "https://openrouter.ai/api/v1/chat/completions",
        { ...authHeaders(options), "Content-Type": "application/json" },
        JSON.stringify({
            model: options.id,
            messages: [
                {
                    role: "user",
                    content: [
                        ...options.images.map((image) => ({
                            type: "image_url",
                            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                        })),
                        { type: "text", text: options.prompt },
                    ],
                },
            ],
            modalities: ["image", "text"],
        }),
        options.signal,
    );
    const images: GeneratedImage[] = [];
    for (const image of json?.choices?.[0]?.message?.images ?? []) {
        const url = typeof image?.image_url === "string" ? image.image_url : image?.image_url?.url;
        if (typeof url !== "string" || !url) continue;
        const match = url.match(/^data:([^;]+);base64,(.*)$/s);
        images.push(match ? { data: match[2], mimeType: match[1] } : await download(url, options.signal));
    }
    if (images.length === 0) throw new Error(`OpenRouter returned no images: ${JSON.stringify(json).slice(0, 300)}`);
    return images;
}

async function download(url: string, signal?: AbortSignal): Promise<GeneratedImage> {
    const response = await fetch(url, { signal: signal ?? null });
    if (!response.ok) throw new Error(`Downloading generated image failed: ${response.status}`);
    return {
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
        mimeType: response.headers.get("content-type")?.split(";")[0] || "image/png",
    };
}

export function readInputImage(cwd: string, path: string): ImageContent {
    const root = realpathSync(cwd);
    let file: string;
    try {
        file = realpathSync(resolve(root, path));
    } catch {
        throw new Error(`Input image "${path}" not found`);
    }
    // Trust boundary: the resolved path (symlinks included) must stay inside the working directory.
    if (file !== root && !file.startsWith(root + sep)) {
        throw new Error(`Input image "${path}" must stay inside the working directory`);
    }
    const mimeType = INPUT_MIME[extname(file).toLowerCase()];
    if (!mimeType) throw new Error(`Input image "${path}" must be a png, jpg, gif, webp, or bmp file`);
    if (statSync(file).size > 20 * 1024 * 1024)
        throw new Error(`Input image "${path}" is larger than 20 MB and cannot be sent for editing`);
    return { type: "image", data: readFileSync(file).toString("base64"), mimeType };
}

export function saveImages(cwd: string, outputDir: string, images: GeneratedImage[]): string[] {
    const dir = resolve(cwd, outputDir);
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    return images.map((image, index) => {
        const file = join(dir, `image-${stamp}-${index + 1}.${extFor(image.mimeType)}`);
        writeFileSync(file, Buffer.from(image.data, "base64"));
        return relative(cwd, file);
    });
}

function extFor(mimeType: string): string {
    const ext = mimeType.split("/")[1] ?? "";
    return ext === "jpeg" ? "jpg" : ext || "png";
}
