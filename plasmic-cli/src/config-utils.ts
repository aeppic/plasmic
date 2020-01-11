import fs from "fs";
import path from "path";
import os from "os";
import L from "lodash";
import { writeFileContent } from "./file-utils";
import { PlasmicApi } from "./api";

export const AUTH_FILE_NAME = ".plasmic.auth";
export const CONFIG_FILE_NAME = "plasmic.json";


export interface PlasmicConfig {
  // Target platform to generate code for
  platform: "react";

  // Language to generate code in
  lang: "ts";

  // Code generation scheme
  scheme: "blackbox";

  // Styling framework to use
  style: "css";

  // The folder containing the source files; this is the default place where
  // generated code is dumped and found.
  srcDir: string;

  // Configs for each component we have synced.
  components: ComponentConfig[];
}

/**
 * Describes how to import a Component
 */
export interface ImportSpec {
  // The import path to use to instantiate this Component.  The modulePath can be:
  // * An external npm module, like "antd/lib/button"
  // * An aliased path, like "@app/components/Button"
  // * A local file, like "components/Button.tsx" (path is relative to srcDir, and file
  //   extension is fully specified).  If local file is specified, then the module is imported
  //   via relative path.
  modulePath: string;

  // If the Component is a named export of the module, then this is the name.  If the Component
  // is the default export, then this is undefined.
  exportName?: string;
}

export interface ComponentConfig {
  id: string;
  name: string;
  type: "managed";
  projectId: string;

  // The file path for the blackbox render module, relative to srcDir.
  renderModuleFilePath: string;

  // The file path for the component css file, relative to srcDir.
  cssFilePath: string;

  // How to import this Component
  importSpec: ImportSpec;
}

/**
 * PlasmicContext is the PlasmicConfig plus context in which the PlasmicConfig was
 * created.
 */
export interface PlasmicContext {
  // Location of the plasmic.json file
  configFile: string;

  // Folder where plasmic.json file lives
  rootDir: string;

  // The parsed PlasmicConfig
  config: PlasmicConfig;

  // The parsed AuthConfig
  auth: AuthConfig;

  // Api instance to use for talking to Plasmic
  api: PlasmicApi;
}

export interface AuthConfig {
  // Plasmic web app host
  host: string;

  // Plasmic user email
  user: string;

  // Plasmic API token
  token: string;

  // If Plasmic instance is gated by basic auth, the basic auth user and password
  basicAuthUser?: string;
  basicAuthPassword?: string;
}

export const DEFAULT_CONFIG: PlasmicConfig = {
  platform: "react",
  lang: "ts",
  scheme: "blackbox",
  style: "css",
  srcDir: ".",
  components: []
};

/**
 * Finds the full path to the plasmic.json file in `dir`.  If
 * `opts.traverseParents` is set to true, then will also look in ancestor
 * directories until the plasmic.json file is found.  If none is found,
 * returns undefined.
 */
export function findConfigFile(dir: string, opts: {
  traverseParents?: boolean
}): string|undefined {
  return findFile(dir, f => f === CONFIG_FILE_NAME, opts);
}

export function findAuthFile(dir: string, opts: {
  traverseParents?: boolean
}) {
  let file = findFile(dir, f => f === AUTH_FILE_NAME, opts);
  if (!file) {
    file = findFile(os.homedir(), f => f === AUTH_FILE_NAME, {traverseParents: false});
  }
  return file;
}

/**
 * Finds the full path to the first file satisfying `pred` in `dir`.  If
 * `opts.traverseParents` is set to true, then will also look in ancestor
 * directories until the plasmic.json file is found.  If none is found,
 * returns undefined.
 */
function findFile(dir: string, pred: (name: string) => boolean, opts: {
  traverseParents?: boolean
}): string | undefined {
  const files = fs.readdirSync(dir);
  const found = files.find(f => pred(f));
  if (found) {
    return path.join(dir, found);
  }
  if (dir === '/' || !opts.traverseParents) {
    return undefined;
  }
  return findFile(path.dirname(dir), pred, opts);

}

/**
 * Given some partial configs for PlasmicConfig, fills in all required fields
 * with default values.
 */
export function fillDefaults(config: Partial<PlasmicConfig>): PlasmicConfig {
  return L.defaults(config, DEFAULT_CONFIG);
}

export function getContext(): PlasmicContext {
  const configFile = findConfigFile(process.cwd(), {traverseParents: true});
  if (!configFile) {
    console.error('No plasmic.json file found; please run `plasmic init` first.');
    process.exit(1);
  }
  const authFile = findAuthFile(process.cwd(), {traverseParents: true});
  if (!authFile) {
    console.log("No .plasmic.auth file found with Plasmic credentials; please run `plasmic init` first.");
    process.exit(1);
  }
  const auth = readAuth(authFile);
  return {
    config: readConfig(configFile),
    configFile,
    rootDir: path.dirname(configFile),
    auth,
    api: new PlasmicApi(auth),
  };
}

export function readConfig(configFile: string) {
  try {
    const result = JSON.parse(fs.readFileSync(configFile!).toString()) as PlasmicConfig;
    return fillDefaults(result);
  } catch (e) {
    console.error(`Error encountered reading plasmic.config at ${configFile}: ${e}`);
    process.exit(1);
  }
}

export function readAuth(authFile: string) {
  try {
    return JSON.parse(fs.readFileSync(authFile).toString()) as AuthConfig;
  } catch (e) {
    console.error(`Error encountered reading plasmic credentials at ${authFile}: ${e}`);
    process.exit(1);
  }
}

export function writeConfig(configFile: string, config: PlasmicConfig) {
  writeFileContent(configFile, JSON.stringify(config, undefined, 2), {force: true});
}

export function writeAuth(authFile: string, config: AuthConfig) {
  writeFileContent(authFile, JSON.stringify(config, undefined, 2), {force: true});
  fs.chmodSync(authFile, "600");
}

export function updateConfig(context: PlasmicContext, updates: Partial<PlasmicConfig>) {
  let config = readConfig(context.configFile);
  config = {...config, ...updates};
  writeConfig(context.configFile, config);
  context.config = config;
}