/**
 * Lavka's page state, as JavaScript source for the operations' `run`
 * functions: `lavkaPage()` answers `{ page, queries }`, the page's props
 * and its query state, or `null` when Lavka sends a check instead of its
 * page. On Lavka's own page they are `window.__PAGE_PROPS__` and
 * `window.__REACT_QUERY_STATE__`; on a light page of the same origin (a
 * `robots.txt`, a second to open instead of five) they are read from the
 * JSON the home page embeds for them, which is the very text the page
 * itself parses: `<script id="__page_props__-data">`. Nothing is run from
 * it, it is only parsed as data.
 */
export const lavkaPageSource = `
const lavkaPage = async () => {
  if (window.__PAGE_PROPS__ && window.__REACT_QUERY_STATE__) {
    return { page: window.__PAGE_PROPS__, queries: window.__REACT_QUERY_STATE__.queries };
  }
  const response = await fetch("/", { credentials: "include" });
  if (response.status === 429 || /captcha/.test(response.url || "")) return null;
  const html = await response.text();
  const embedded = (id) => {
    const open = html.indexOf('<script id="' + id + '"');
    if (open < 0) return null;
    const start = html.indexOf(">", open) + 1;
    const end = html.indexOf("</script>", start);
    return end < 0 ? null : JSON.parse(html.slice(start, end));
  };
  const page = embedded("__page_props__-data");
  const state = embedded("__react_query_state__-data");
  if (!page || !state) throw new Error("no state in the page");
  return { page, queries: state.queries };
};
`;
