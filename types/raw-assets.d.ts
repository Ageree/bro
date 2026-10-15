declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare module "*.py?raw" {
  const content: string;
  export default content;
}

// eve's asset plugin turns a relative import of any other suffix into a
// base64 data URL (`internal/authored-asset-import-plugin.js`).
declare module "*.ttf?inline" {
  const dataUrl: string;
  export default dataUrl;
}

declare module "*.pdf?inline" {
  const dataUrl: string;
  export default dataUrl;
}
