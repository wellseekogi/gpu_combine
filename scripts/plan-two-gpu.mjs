import {readFile, writeFile} from "node:fs/promises";
import {planTwoGpuLayers} from "../lib/relay/inference-plan.mjs";

const [configPath, weightsPath, groupId, outputPath, ...extra] = process.argv.slice(2);
if (!outputPath || extra.length) {
  console.error("Usage: node scripts/plan-two-gpu.mjs CONFIG.json WEIGHTS.json GROUP_ID NEW_CONFIG.json");
  process.exitCode = 1;
} else {
  try {
    const readJson = async path => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    const [config, weights] = await Promise.all([readJson(configPath), readJson(weightsPath)]);
    const result = planTwoGpuLayers(config, groupId, weights);
    await writeFile(outputPath, JSON.stringify(result.config, null, 2) + "\n", {flag: "wx"});
    console.log(JSON.stringify({source: result.source, feasibleSplits: result.feasibleSplits,
      gpus: result.plan.gpus.map(({id, layers, weightsMiB, kvMiB, headroomMiB}) => ({id, layers, weightsMiB, kvMiB, headroomMiB})),
      note: "Capacity estimate only. Stop the old group before applying; verify actual peak VRAM after loading."}, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
