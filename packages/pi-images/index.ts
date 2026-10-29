import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { generateImages, imageKey, readInputImage, saveImages, splitModel } from "./generate.ts";

export type ImagesSettings = {
    vision?: string;
    generate?: string;
    outputDir?: string;
};

const OMITTED_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

const VISION_PROMPT = [
    "You are the eyes of a coding agent that cannot see this image.",
    "Describe it exhaustively and factually so the agent can act without seeing it:",
    "transcribe all text and code verbatim, describe the UI or document layout (elements, arrangement, colors),",
    "and quote any error messages exactly. Reply with the description only, no preamble.",
].join(" ");

// Descriptions are cached by a hash of the image data, so each image is described once per process.
const descriptions = new Map<string, Promise<string>>();
let warnedNotVision = false;

function imagesFrom(path: string): ImagesSettings {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        const images = parsed && typeof parsed === "object" ? (parsed as { images?: unknown }).images : undefined;
        if (!images || typeof images !== "object") return {};
        const { vision, generate, outputDir } = images as Record<string, unknown>;
        return {
            ...(typeof vision === "string" && vision ? { vision } : {}),
            ...(typeof generate === "string" && generate ? { generate } : {}),
            ...(typeof outputDir === "string" && outputDir ? { outputDir } : {}),
        };
    } catch {
        return {};
    }
}

export function mergeImagesSettings(global: ImagesSettings, project: ImagesSettings): ImagesSettings {
    return { ...global, ...project };
}

export function readImagesSettings(cwd: string): ImagesSettings {
    return mergeImagesSettings(
        imagesFrom(join(getAgentDir(), "settings.json")),
        imagesFrom(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    );
}

function describeImage(ctx: ExtensionContext, model: Model<Api>, block: ImageContent): Promise<string> {
    const key = imageKey(block);
    let description = descriptions.get(key);
    if (!description) {
        description = ctx.modelRegistry
            .complete(
                model,
                { systemPrompt: VISION_PROMPT, messages: [{ role: "user", content: [block], timestamp: Date.now() }] },
                { signal: ctx.signal },
            )
            .then((result) => {
                const text = result.content
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .trim();
                if (!text) throw new Error("the vision model returned no description");
                return text;
            })
            .catch((error: unknown) => {
                // Cache the failure so later requests skip the vision call; this caller still reports it once.
                descriptions.set(key, Promise.resolve("unavailable"));
                throw error;
            });
        descriptions.set(key, description);
    }
    return description;
}

/** Content blocks of a message the vision model must replace, or undefined when it carries no image. */
function imageContentOf(message: unknown): any[] | undefined {
    const record = message as { role?: unknown; content?: any };
    if (record.role !== "user" && record.role !== "toolResult") return undefined;
    if (!Array.isArray(record.content)) return undefined;
    return record.content.some((block) => block?.type === "image") ? record.content : undefined;
}

export default function (pi: ExtensionAPI) {
    pi.on("context", async (event, ctx) => {
        // The hook runs on every LLM call; bail before touching settings when the model already sees images.
        if (ctx.model?.input.includes("image")) return;
        const settings = readImagesSettings(ctx.cwd);
        if (!settings.vision) return;

        if (!event.messages.some((message) => imageContentOf(message) !== undefined)) return;

        let model: Model<Api> | undefined;
        try {
            const { provider, id } = splitModel(settings.vision);
            model = ctx.modelRegistry.find(provider, id);
        } catch {
            model = undefined;
        }
        if (!model) {
            ctx.ui.notify(
                `images.vision "${settings.vision}" does not resolve to a known model; images pass through undescribed`,
                "warning",
            );
            return;
        }
        if (!model.input.includes("image")) {
            if (!warnedNotVision) {
                warnedNotVision = true;
                ctx.ui.notify(
                    `images.vision "${settings.vision}" cannot see images; images pass through undescribed`,
                    "warning",
                );
            }
            return;
        }

        const messages = [];
        for (const message of event.messages) {
            const content = imageContentOf(message);
            if (!content) {
                messages.push(message);
                continue;
            }
            const next = [];
            for (const block of content) {
                const typed = block as { type?: unknown; text?: unknown };
                if (typed.type === "image") {
                    const description = await describeImage(ctx, model, block as ImageContent).catch(
                        (error: unknown) => {
                            ctx.ui.notify(
                                `Describing an image with ${settings.vision} failed: ${error instanceof Error ? error.message : String(error)}`,
                                "error",
                            );
                            return "unavailable";
                        },
                    );
                    next.push({ type: "text", text: `[Image description: ${description}]` });
                } else if (typed.type === "text" && typeof typed.text === "string") {
                    const text = typed.text.replaceAll(OMITTED_NOTE, "").trim();
                    if (text) next.push({ type: "text", text });
                } else {
                    next.push(block);
                }
            }
            messages.push({ ...message, content: next });
        }
        return { messages };
    });

    pi.registerTool({
        name: "image_generate",
        label: "Image generate",
        description:
            "Generate images from a text prompt, or edit input images. Input images are file paths inside the working " +
            "directory. Returns the generated images as attachments and saves them under the configured images output " +
            "directory. For bitmap assets only; icons, logos and diagrams belong in SVG or CSS.",
        promptSnippet: "Generate or edit images from a prompt",
        promptGuidelines: [
            "Use image_generate only for bitmap assets (photos, illustrations, textures, mockups); do not use it for icons, logos or diagrams that belong in SVG or CSS.",
            "To edit an existing image with image_generate, pass it in `image` and state what to change and what to keep unchanged, and repeat that on every iteration.",
            "Quote any in-image text verbatim in the image_generate prompt, keep its exact capitalization, and say how many times it appears.",
            "Make one image_generate call per distinct asset.",
            "Show image_generate results inline using the returned `![alt](path)` lines.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "What to generate, or how to edit the input images." }),
            image: Type.Optional(
                Type.Array(Type.String(), {
                    description: "Input image file paths inside the working directory, for edits or reference.",
                }),
            ),
            size: Type.Optional(
                Type.String({
                    description: 'Optional size hint, e.g. "1024x1024". Ignored by providers without a size knob.',
                }),
            ),
        }),
        async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
            // Strict models inject literal "null" for optional params they omit; drop it from the optionals, not the prompt.
            const params = { ...rawParams } as typeof rawParams & Record<string, unknown>;
            for (const key of ["image", "size"]) {
                if (params[key] === null || params[key] === "null") delete params[key];
            }
            const settings = readImagesSettings(ctx.cwd);
            if (!settings.generate) {
                throw new Error(
                    'Set "images.generate" to "provider/model-id" in .pi/settings.json to use image_generate.',
                );
            }
            const { provider, id } = splitModel(settings.generate);
            const providerModel = ctx.modelRegistry.getAll().find((model) => model.provider === provider);
            if (!providerModel) {
                throw new Error(`Provider "${provider}" is not known to pi; no model is registered for it.`);
            }
            // Registered providers (e.g. inferhub) can set a per-provider baseUrl/api; a provider's first model may use a different one.
            const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(provider);
            const api = providerConfig?.api ?? providerModel.api;
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(providerModel);
            if (!auth.ok) throw new Error(auth.error);
            const baseUrl = auth.baseUrl ?? providerConfig?.baseUrl ?? providerModel.baseUrl;

            const images = (params.image ?? []).map((path) => readInputImage(ctx.cwd, path));
            const generated = await generateImages({
                provider,
                id,
                api,
                baseUrl,
                apiKey: auth.apiKey,
                headers: auth.headers,
                prompt: params.prompt,
                size: params.size,
                images,
                signal,
            });
            const paths = saveImages(ctx.cwd, settings.outputDir ?? ".pi/images", generated);
            return {
                content: [
                    { type: "text", text: paths.map((path) => `![generated image](${path})`).join("\n") },
                    ...generated.map((image) => ({
                        type: "image" as const,
                        data: image.data,
                        mimeType: image.mimeType,
                    })),
                ],
                details: { paths },
            };
        },

        renderCall(args, theme, context) {
            const model = readImagesSettings(context.cwd).generate;
            const lines = String(args?.prompt ?? "")
                .trim()
                .split("\n");
            const shown = context.expanded ? lines : lines.slice(0, 5);
            const more = lines.length - shown.length;
            const container = new Container();
            container.addChild(
                new TruncatedText(
                    `${theme.fg("toolTitle", theme.bold("image_generate"))}${model ? ` ${theme.fg("muted", model)}` : ""}`,
                ),
            );
            if (shown.join("").trim())
                container.addChild(
                    new Text(
                        theme.fg("toolOutput", shown.join("\n")) +
                            (more > 0 ? `\n${theme.fg("muted", `... (${more} more lines, ctrl+o to expand)`)}` : ""),
                        0,
                        0,
                    ),
                );
            return container;
        },

        renderResult(result, { isPartial }, theme, context) {
            const text = result.content
                .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
                .join("\n");
            if (context.isError) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
            if (isPartial) return new Text(`\n${theme.fg("muted", "generating…")}`, 0, 0);
            const paths = (result.details as { paths?: string[] } | undefined)?.paths ?? [];
            return new Text(`\n${paths.map((path) => theme.fg("toolOutput", path)).join("\n")}`, 0, 0);
        },
    });
}
