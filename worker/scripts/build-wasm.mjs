// Compiles src/dot.wat -> src/dot.wasm (committed, so normal builds don't need wabt).
import { readFileSync, writeFileSync } from "node:fs";
import wabtInit from "wabt";
const wabt = await wabtInit();
const mod = wabt.parseWat("dot.wat", readFileSync(new URL("../src/dot.wat", import.meta.url), "utf8"), { simd: true });
const { buffer } = mod.toBinary({});
writeFileSync(new URL("../src/dot.wasm", import.meta.url), Buffer.from(buffer));
console.log(`dot.wasm: ${buffer.length} bytes`);
