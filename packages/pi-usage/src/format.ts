/** Text helpers shared by the table views and the Summary view. */

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GroupMode, GroupRow, Stats } from "./usage.ts";

const BAR_CELLS = 8;

export function formatCost(cost: number): string {
    if (cost === 0) return "$0.00";
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 100) return `$${cost.toFixed(2)}`;
    return `$${Math.round(cost).toLocaleString("en-US")}`;
}

export function formatTokens(count: number): string {
    if (count === 0) return "-";
    if (count < 1000) return String(count);
    if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
    if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    return `${(count / 1_000_000_000).toFixed(1)}B`;
}

/** Cache reads as a share of the whole input, colored by how much of the session the cache carried. */
export function hitPct(stats: Stats, theme: Theme): string {
    const total = stats.input + stats.cacheRead + stats.cacheWrite;
    if (total === 0) return "-";
    const pct = Math.round((100 * stats.cacheRead) / total);
    return theme.fg(pct >= 90 ? "success" : pct >= 75 ? "warning" : "error", `${pct}%`);
}

export function padWidth(s: string, w: number): string {
    return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
}

/** Truncate a name to its column so ANSI codes and padding stay width-correct. */
export function fitLabel(name: string, nameWidth: number): string {
    return visibleWidth(name) > nameWidth ? truncateToWidth(name, nameWidth, "…") : name;
}

/** Thin bar: heavy for the filled part, light for the rest, so a row reads as a line, not a block. */
export function shareBar(cost: number, totalCost: number, theme: Theme): string {
    const share = totalCost > 0 ? Math.min(1, Math.max(0, cost / totalCost)) : 0;
    const halves = Math.round(share * BAR_CELLS * 2);
    const full = Math.floor(halves / 2);
    const half = halves % 2 === 1 ? "╸" : "";
    return (
        theme.fg("accent", "━".repeat(full) + half) +
        theme.fg("borderMuted", "─".repeat(BAR_CELLS - full - half.length)) +
        " " +
        `${Math.round(100 * share)}%`.padStart(4)
    );
}

/** One top list row: name, share bar and cost. */
export function topLine(row: GroupRow, totalCost: number, nameWidth: number, theme: Theme): string {
    return [
        padWidth(fitLabel(row.name, nameWidth), nameWidth),
        shareBar(row.stats.cost, totalCost, theme),
        formatCost(row.stats.cost).padStart(9),
    ].join(" ");
}
/** `theme` marks a weekend day; the breadcrumb and list callers leave the weekday suffix plain. */
export function displayName(mode: GroupMode, name: string, theme?: Theme): string {
    if (mode === "day") {
        const weekday = new Date(`${name}T00:00`).toLocaleDateString("en-US", { weekday: "short" });
        if (theme === undefined || (weekday !== "Sat" && weekday !== "Sun")) return `${name} ${weekday}`;
        return `${name} ${theme.fg("accent", weekday)}`;
    }
    if (mode !== "project") return name;
    if (!name) return "(no cwd)";
    const home = homedir();
    return name === home || name.startsWith(home + "/") ? "~" + name.slice(home.length) : name;
}

/** Rise in red, fall in green: the money spent, not the money saved. */
export function deltaText(delta: number | undefined, theme: Theme): string {
    if (delta === undefined) return "-";
    if (delta === 0) return "0%";
    const text = Number.isFinite(delta) ? `${delta > 0 ? "▲" : "▼"}${Math.round(Math.abs(delta))}%` : "▲new";
    return theme.fg(delta > 0 ? "error" : "success", text);
}

export function clip(lines: string[], width: number, rows: number): string[] {
    return lines.slice(0, rows).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}
