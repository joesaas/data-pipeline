// Fail fast with a plain message when Node is too old, instead of a cryptic
// parser crash deep inside the TypeScript compiler.
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(
    `data-pipeline needs Node >= 22 (this server has ${process.versions.node}).\n` +
      "The SQLite storage driver uses the built-in node:sqlite module.\n" +
      "Fix with nvm:  nvm install 22 && nvm alias default 22",
  );
  process.exit(1);
}
