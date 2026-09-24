import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";

/**
 * The benchmark driver: `pnpm bench --help`. How to run it against a local
 * stand or production is in `docs/benchmarks/README.md`.
 *
 * The driver reuses application modules (the `send_message` contract, media
 * sniffing, voice transcription), so TypeScript path resolution is installed
 * before anything from the application loads.
 */
registerApplicationModuleResolution();

await import("./cli.ts");
