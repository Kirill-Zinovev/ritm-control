// Synthetic IDs only. No local private config is copied into migration tests.
const names = ["SEASONAL_PRINTING_ID", "ROLL_PRINTING_ID", "BOX_PRINTING_ID", "CATALOG_ID", "FBO_SOURCE_ID", "ASSEMBLY_DATABASE_ID", "OZON_CODES_CATALOG_ID"];
for (const name of names) process.env["RITM_GOOGLE_" + name] = "SYNTHETIC_" + name + "_00000000000000000000";
process.env.RITM_ASSEMBLY_WEB_APP_URL = "https://script.google.com/macros/s/SYNTHETIC_TEST_ONLY_0000000000000000/exec";
process.env.RITM_PRIVATE_CONFIG_PATH = new URL("./nonexistent-private-config.json", import.meta.url).pathname;
export const bindings = Object.fromEntries(names.map((name) => ["RITM_GOOGLE_" + name, process.env["RITM_GOOGLE_" + name]]));
