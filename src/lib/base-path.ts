/**
 * Base path for hosts that serve the site from a subdirectory, such as a
 * GitHub Pages project site. next/link and next/font handle this on their own;
 * anything we fetch or point an <audio src> at does not, so it goes through here.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const asset = (path: string) => `${basePath}${path}`;
