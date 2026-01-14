// scripts/update-changelog.js
// Automatically updates CHANGELOG.md during `npm version` to replace
// ## [Unreleased] with [vX.X.X] - YYYY-MM-DD

const fs = require("fs");
const path = require("path");

const pkgPath = path.join(__dirname, "..", "package.json");
const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const changelog = fs.readFileSync(changelogPath, "utf8");

const date = new Date().toISOString().split("T")[0];
const newSection = `## [v${pkg.version}] - ${date}`;

const updated = changelog.replace("## [Unreleased]", newSection);

if (updated === changelog) {
  console.error("Warning: Could not find '## [Unreleased]' in CHANGELOG.md");
  process.exit(1);
}

fs.writeFileSync(changelogPath, updated);
console.log(`Updated CHANGELOG.md with v${pkg.version}`);
