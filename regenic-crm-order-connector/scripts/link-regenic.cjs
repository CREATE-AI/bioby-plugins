const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "../node_modules/@regenic");
fs.mkdirSync(dir, { recursive: true });

const packages = {
  domain: path.resolve(__dirname, "../../../regenic/packages/domain"),
  "plugin-host": path.resolve(__dirname, "../../../regenic/packages/plugin-host"),
};

for (const [name, target] of Object.entries(packages)) {
  const link = path.join(dir, name);
  try {
    fs.unlinkSync(link);
  } catch {
    // first run
  }
  fs.symlinkSync(target, link, "dir");
}
