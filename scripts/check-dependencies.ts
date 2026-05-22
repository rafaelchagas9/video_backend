#!/usr/bin/env bun
import { existsSync } from "fs";
import { access, constants } from "node:fs/promises";
import { execSync } from "child_process";

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

const checks: CheckResult[] = [];

async function checkFileExists(
  path: string,
  name: string,
): Promise<CheckResult> {
  try {
    await access(path, constants.F_OK | constants.X_OK);
    return {
      name,
      passed: true,
      message: `Found at ${path}`,
    };
  } catch {
    return {
      name,
      passed: false,
      message: `Not found at ${path}`,
    };
  }
}

async function checkPostgres(): Promise<CheckResult> {
  try {
    const host = process.env.POSTGRES_HOST || "localhost";
    const port = process.env.POSTGRES_PORT || "5432";

    execSync(
      `timeout 5 bash -c "cat < /dev/null > /dev/tcp/${host}/${port}" 2>/dev/null`,
      {
        stdio: "ignore",
        timeout: 6000,
      },
    );

    return {
      name: "PostgreSQL",
      passed: true,
      message: `Accessible at ${host}:${port}`,
    };
  } catch {
    return {
      name: "PostgreSQL",
      passed: false,
      message: `Not accessible at ${process.env.POSTGRES_HOST || "localhost"}:${process.env.POSTGRES_PORT || "5432"}`,
    };
  }
}

async function checkRequiredDirs(): Promise<CheckResult> {
  const dirs = [
    process.env.THUMBNAILS_DIR || "./data/thumbnails",
    process.env.PROFILE_PICTURES_DIR || "./data/profile-pictures",
    process.env.LOGS_DIR || "./logs",
    process.env.STORYBOARDS_DIR || "./data/storyboards",
    process.env.CONVERTED_VIDEOS_DIR || "./data/converted",
  ];

  const missing: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      missing.push(dir);
    }
  }

  if (missing.length === 0) {
    return {
      name: "Required directories",
      passed: true,
      message: "All required directories exist",
    };
  }

  return {
    name: "Required directories",
    passed: false,
    message: `Missing directories: ${missing.join(", ")}`,
  };
}

async function main() {
  console.log("🔍 Checking dependencies...\n");

  const ffmpegPath = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "/usr/bin/ffprobe";

  checks.push(await checkFileExists(ffmpegPath, "FFmpeg"));
  checks.push(await checkFileExists(ffprobePath, "FFprobe"));
  checks.push(await checkPostgres());
  checks.push(await checkRequiredDirs());

  let allPassed = true;
  for (const check of checks) {
    const icon = check.passed ? "✅" : "❌";
    console.log(`${icon} ${check.name}`);
    console.log(`   ${check.message}\n`);

    if (!check.passed) {
      allPassed = false;
    }
  }

  if (allPassed) {
    console.log("✨ All dependencies are satisfied!");
    process.exit(0);
  } else {
    console.error(
      "⚠️  Some dependencies are missing. Please fix the issues above.",
    );
    process.exit(1);
  }
}

main();
