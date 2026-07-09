/**
 * pdf-parse@1.x ships no type definitions (module.exports = function).
 * Minimal ambient declaration covering the fields the scraper sanity check uses.
 *
 * We import the inner `lib/pdf-parse.js` directly rather than the package's
 * `index.js` entrypoint — index.js has a `!module.parent` "debug mode" check
 * that reads a fixture PDF that doesn't exist in this repo. Webpack (Next.js
 * build) doesn't populate `module.parent` the way plain Node does, so
 * importing the package root would run that debug block at build time and
 * crash with an ENOENT. `lib/pdf-parse.js` is the real implementation with
 * no such side effect.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PDFParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }

  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PDFParseResult>;

  export = pdfParse;
}
