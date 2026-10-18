// Keychain-backed secret storage, via the macOS built-in `security` CLI.
//
// We deliberately avoid a native module (keytar) here: it has no prebuilt
// binary for current Node and would need a C++ toolchain to compile. The
// `security` command talks to the same login Keychain with zero dependencies.
// All Jarvis secrets live under the service "jarvis" — never in code, .env, logs
// or the browser.
import { execFile } from "node:child_process";
import readline from "node:readline";

const SERVICE = "jarvis";

export const KEYS = {
  CLAUDE_API_KEY: "claude-api-key",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REFRESH_TOKEN: "google-refresh-token",
};

const FIRST_RUN_PROMPTS = [
  { key: KEYS.CLAUDE_API_KEY, label: "Claude API key (from console.anthropic.com)" },
  { key: KEYS.GOOGLE_CLIENT_ID, label: "Google OAuth client ID (Desktop app)" },
  { key: KEYS.GOOGLE_CLIENT_SECRET, label: "Google OAuth client secret" },
];

function run(args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile("security", args, (err, stdout) => {
      if (err) {
        if (allowFail) return resolve(null);
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// Earlier names for the assistant; secrets may still live under these services.
const LEGACY_SERVICES = ["jasmine", "wazir"];

async function find(service, key) {
  // -w prints just the password; a missing item exits non-zero (allowFail → null).
  const out = await run(["find-generic-password", "-s", service, "-a", key, "-w"], { allowFail: true });
  const v = out == null ? null : out.replace(/\n$/, "");
  return v || null;
}

export async function getSecret(key) {
  const v = await find(SERVICE, key);
  if (v) return v;
  // One-off move from an old service name, so no keys need re-entering.
  for (const legacyService of LEGACY_SERVICES) {
    const legacy = await find(legacyService, key);
    if (!legacy) continue;
    await setSecret(key, legacy);
    await run(["delete-generic-password", "-s", legacyService, "-a", key], { allowFail: true });
    return legacy;
  }
  return null;
}

export async function setSecret(key, value) {
  // -U updates the item if it already exists instead of erroring.
  await run(["add-generic-password", "-s", SERVICE, "-a", key, "-w", value, "-U"]);
}

export async function deleteSecret(key) {
  await run(["delete-generic-password", "-s", SERVICE, "-a", key], { allowFail: true });
}

export async function hasCoreSecrets() {
  const vals = await Promise.all(FIRST_RUN_PROMPTS.map((p) => getSecret(p.key)));
  return vals.every(Boolean);
}

// Ask once for anything missing, reading from the terminal.
export async function ensureCoreSecrets() {
  for (const { key, label } of FIRST_RUN_PROMPTS) {
    if (await getSecret(key)) continue;
    const value = await prompt(`Enter ${label}: `);
    if (!value) throw new Error(`No value provided for ${label}`);
    await setSecret(key, value.trim());
    console.log(`  stored ${key} in Keychain`);
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
