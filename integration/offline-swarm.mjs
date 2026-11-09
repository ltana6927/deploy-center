import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "yaml";

const root = process.cwd();
const workflow = parse(readFileSync(join(root, ".github/workflows/deploy.yml"), "utf8"));
const step = (name) => workflow.jobs.deploy.steps.find((candidate) => candidate.name === name);
const imageStep = workflow.jobs.deploy.steps.find((candidate) => candidate.id === "image");
const directory = mkdtempSync(join(tmpdir(), "deploy-offline-swarm-"));
const name = `deploy-offline-${randomUUID()}`;
const network = `${name}-network`;
const service = "app_example-api";
const sourceSha = "a".repeat(40);
const imageRef = `ghcr.io/ltana6927/example/api:${sourceSha}`;
const registryDigest = `ghcr.io/ltana6927/example/api@sha256:${"b".repeat(64)}`;
const dockerBinary = spawnSync("which", ["docker"], { encoding: "utf8" }).stdout.trim();
const pythonBinary = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${binary} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

const docker = (...args) => command(dockerBinary, args);
const engine = (...args) => docker("exec", name, "docker", ...args);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

try {
  // The daemon has no internet route, host socket, published port or host mount.
  // Its anonymous data volume is removed with this test container in finally.
  docker("network", "create", "--internal", network);
  docker("run", "--privileged", "--detach", "--name", name, "--network", network,
    "--env", "DOCKER_TLS_CERTDIR=", "docker:25.0.5-dind@sha256:b41d0183012e2334aacd4e0b8e339b89246c4fdb7eada6cc86b0355f41328549",
    "--storage-driver=vfs", "--tls=false");
  for (let attempt = 0; ; attempt++) {
    const ready = spawnSync(dockerBinary, ["exec", name, "docker", "info"], { encoding: "utf8", timeout: 5000 });
    if (ready.status === 0) break;
    assert.ok(attempt < 60, "Isolated Docker did not start");
    pause(500);
  }
  const base = command(dockerBinary, ["image", "save", "busybox:1.36"], { encoding: null });
  command(dockerBinary, ["exec", "-i", name, "docker", "image", "load"], { input: base, encoding: null });
  // Capture swarm-init output: it contains a join token and must not reach CI logs.
  engine("swarm", "init", "--advertise-addr", "eth0");
  function build(tag, revision) {
    command(dockerBinary, ["exec", "--env", "DOCKER_BUILDKIT=0", "-i", name, "docker", "build", "--network=none", "--tag", tag, "-"], {
      input: `FROM busybox:1.36\nENV PATH=/bin:/usr/bin\nLABEL org.opencontainers.image.revision="${revision}"\nCMD ["/bin/busybox","sleep","3600"]\n`,
    });
  }
  build("offline-seed:old", "d".repeat(40));
  build(imageRef, sourceSha);
  const imageId = engine("image", "inspect", imageRef, "--format", "{{.Id}}").trim();
  const exported = command(dockerBinary, ["exec", name, "docker", "image", "save", imageRef], { encoding: null });
  const archiveImage = join(directory, "main-image.tar.gz");
  writeFileSync(archiveImage, gzipSync(exported));
  writeFileSync(join(directory, "image.json"), JSON.stringify({ image_ref: imageRef, image_digest: registryDigest, image_id: imageId, revision: sourceSha }));
  const zip = join(directory, "fixture.zip");
  command(pythonBinary, ["-c", "import hashlib,pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\ndata=(p/'main-image.tar.gz').read_bytes()\nwith zipfile.ZipFile(p/'fixture.zip','w') as z:\n z.write(p/'main-image.tar.gz','main-image.tar.gz')\n z.write(p/'image.json','image.json')\n z.writestr('main-image.tar.gz.sha256',hashlib.sha256(data).hexdigest()+'  main-image.tar.gz')", directory]);
  const zipBytes = readFileSync(zip);
  engine("image", "rm", imageRef);
  engine("service", "create", "--detach=false", "--name", service, "--update-monitor", "1s", "--no-resolve-image", "offline-seed:old");

  const bin = join(directory, "bin");
  mkdirSync(bin);
  const callsPath = join(directory, "calls");
  writeFileSync(callsPath, "");
  const wrapper = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SWARM_TEST_CALLS, JSON.stringify({name,args})+"\\n");
if(name === "docker") {
  if(args[0] === "pull") process.exit(1);
  if(args.includes("{{ index .RepoDigests 0 }}")) throw new Error("Offline recovery must not resolve RepoDigests");
  if(args[0] === "load") {
    const input=fs.readFileSync(args[args.indexOf("--input")+1]);
    const result=spawnSync(process.env.SWARM_TEST_DOCKER,["exec","-i",process.env.SWARM_TEST_CONTAINER,"docker","load"],{input,stdio:["pipe","inherit","inherit"]});
    process.exit(result.status ?? 1);
  }
  const result = spawnSync(process.env.SWARM_TEST_DOCKER,["exec",process.env.SWARM_TEST_CONTAINER,"docker",...args],{stdio:"inherit"});
  process.exit(result.status ?? 1);
}
if(name === "python3") {
  if(args[0].endsWith("/scripts/download-archive.py")) {
    fs.copyFileSync(process.env.SWARM_TEST_ARCHIVE,path.join(process.env.ARCHIVE_DIR,"image.zip"));
    process.exit(0);
  }
  const result=spawnSync(process.env.SWARM_TEST_PYTHON,args,{stdio:"inherit"});
  process.exit(result.status ?? 1);
}
if(name === "timeout") {
  if(args[2] === "0.001s") process.exit(124);
  const result=spawnSync(args[3],args.slice(4),{stdio:"inherit"});
  process.exit(result.status ?? 1);
}
throw new Error("Unexpected fixture command");
`;
  for (const name of ["docker", "python3", "timeout"]) writeFileSync(join(bin, name), wrapper, { mode: 0o700 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    IMAGE_REF: imageRef, SOURCE_SHA: sourceSha, SOURCE_REPO: "ltana6927/example", SOURCE_READ_TOKEN: "test-only",
    IMAGE_ARCHIVE_ID: "456", IMAGE_ARCHIVE_SIZE: String(zipBytes.length),
    IMAGE_ARCHIVE_DIGEST: `sha256:${createHash("sha256").update(zipBytes).digest("hex")}`,
    IMAGE_RECOVERY_ONLY: "false", SWARM_SERVICE: service, RUNNER_TEMP: directory, GITHUB_WORKSPACE: root,
    REHEARSE_ARCHIVE_RECOVERY: "false",
    DEPLOY_SCRIPT_DIR: join(root, "scripts"),
    SWARM_TEST_DOCKER: dockerBinary, SWARM_TEST_CONTAINER: name, SWARM_TEST_PYTHON: pythonBinary,
    SWARM_TEST_ARCHIVE: zip, SWARM_TEST_CALLS: callsPath,
  };

  function runImage(overrides = {}) {
    const output = join(directory, `output-${randomUUID()}`);
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", imageStep.run], { encoding: "utf8", timeout: 60000, env: { ...env, GITHUB_OUTPUT: output, ...overrides } });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    return { result, outputs };
  }
  function rollout(outputs, overrides = {}) {
    const rolloutEnv = { ...env, IMAGE_SOURCE: outputs.image_source, IMAGE_ID: outputs.image_id, ROLLOUT_IMAGE: outputs.rollout_image, ...overrides };
    if (outputs.already_deployed !== "true") command("bash", ["-c", step("Update Swarm service").run], { env: rolloutEnv });
    command("bash", ["-c", step("Verify recovered Swarm tasks").run], { env: rolloutEnv });
  }

  const first = runImage();
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.outputs.image_source, "archive");
  assert.equal(first.outputs.rollout_image, imageId);
  assert.equal(first.outputs.already_deployed, "false");
  rollout(first.outputs);
  assert.equal(engine("service", "inspect", service, "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}").trim(), imageId);
  console.log("PASS: verified archive updates a real Swarm service with no registry route");

  const before = engine("service", "inspect", service, "--format", "{{.Version.Index}}").trim();
  const second = runImage();
  assert.equal(second.result.status, 0, second.result.stderr);
  assert.equal(second.outputs.already_deployed, "true");
  rollout(second.outputs);
  assert.equal(engine("service", "inspect", service, "--format", "{{.Version.Index}}").trim(), before);
  console.log("PASS: archive redelivery validates running tasks without another rollout");

  const verifyOnly = runImage({ IMAGE_RECOVERY_ONLY: "true" });
  assert.equal(verifyOnly.result.status, 0, verifyOnly.result.stderr);
  assert.equal(engine("service", "inspect", service, "--format", "{{.Version.Index}}").trim(), before);
  const rejected = runImage({ IMAGE_ARCHIVE_DIGEST: `sha256:${"e".repeat(64)}` });
  assert.notEqual(rejected.result.status, 0);
  assert.equal(engine("service", "inspect", service, "--format", "{{.Version.Index}}").trim(), before);
  console.log("PASS: verification-only and invalid archives cannot update the service");

  const rehearsal = runImage({ REHEARSE_ARCHIVE_RECOVERY: "true" });
  assert.equal(rehearsal.result.status, 0, rehearsal.result.stderr);
  assert.match(rehearsal.result.stderr, /exit code 124/);
  assert.equal(rehearsal.outputs.already_deployed, "false");
  rollout(rehearsal.outputs, { REHEARSE_ARCHIVE_RECOVERY: "true" });
  assert.notEqual(engine("service", "inspect", service, "--format", "{{.Version.Index}}").trim(), before);
  console.log("PASS: authenticated rehearsal performs a real rollout of the current image after timeout");

  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.name === "docker" && call.args[0] === "pull").length, 3);
  assert.equal(calls.filter((call) => call.name === "docker" && call.args[0] === "service" && call.args[1] === "update").length, 2);
  console.log("PASS: only initial pulls are attempted; archive recovery never retries GHCR");
} finally {
  spawnSync(dockerBinary, ["rm", "--force", "--volumes", name], { encoding: "utf8" });
  spawnSync(dockerBinary, ["network", "rm", network], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
}
