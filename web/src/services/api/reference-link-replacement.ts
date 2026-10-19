import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { assertUserScope, captureUserScope } from "@/lib/user-scope-guard";

export type ReferenceLinkRequest = { key: string; label: string; name?: string; resourceID?: string; upload?: boolean };
export type ResolveReferenceLinks = (references: ReferenceLinkRequest[], signal?: AbortSignal) => Promise<Record<string, string> | null>;

// Shared by every task submission entry. Only owned resource IDs reach desktop IO.
export async function uploadReferenceLinks(references: ReferenceLinkRequest[], signal?: AbortSignal): Promise<Record<string, string>> {
    const scope = captureUserScope();
    signal?.throwIfAborted();
    const binding = typeof window === "undefined" ? undefined : getDesktopAppBinding();
    const candidates = references.filter((item) => item.resourceID && item.upload !== false);
    if (!binding?.ReferenceStorageSettings || !binding.UploadReferenceMedia || !candidates.length) return {};
    const config = await binding.ReferenceStorageSettings();
    signal?.throwIfAborted();
    assertUserScope(scope);
    if (!config.enabled) return {};
    const urls = await binding.UploadReferenceMedia([...new Set(candidates.map((item) => item.resourceID!))]);
    signal?.throwIfAborted();
    assertUserScope(scope);
    const links: Record<string, string> = {};
    for (const item of candidates) if (isReferenceHTTPSLink(urls[item.resourceID!] || "")) links[item.key] = urls[item.resourceID!];
    return links;
}

export function isReferenceHTTPSLink(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
        return false;
    }
}
