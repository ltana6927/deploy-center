import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { validateDeployConfig } from "./policy.mjs";

const path = process.argv[2];
if (!path) {
  throw new Error("Usage: npm run validate:config -- /path/to/.github/deploy.yml");
}

const sourceRepo = process.env.SOURCE_REPO ?? "ltana6927/example-service";
const [owner, repo] = sourceRepo.split("/");
const request = {
  owner,
  repo,
  sourceRepo,
  sourceSha: "0".repeat(40),
};
const config = YAML.parse(await readFile(path, "utf8"));
const result = validateDeployConfig(
  config,
  request,
  process.env.EXPECTED_SERVER ?? "monadao-prod",
);

console.log(JSON.stringify(result, null, 2));

