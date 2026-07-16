export declare const SOURCE_LATEST_PATH: string;
export declare const SCAN_TARGETS: string[];

export type StaleVersionMatchers = {
  floorVersion: string;
  minorLabel: string;
  visibleVersion: RegExp;
  versionRange: RegExp;
  floor: RegExp;
};

export declare function collectVersionCopyFailures(input: {
  label: string;
  text: string;
  matchers: StaleVersionMatchers;
}): string[];

export declare function collectSourceFiles(path: string): string[];

export declare function isTextSource(path: string): boolean;

export declare function isMinimumSupportedContext(line: string): boolean;

export declare function buildStaleVersionMatchers(
  floorVersion: string,
): StaleVersionMatchers;

export declare function readKnownLatestVersion(path: string): string;

export declare function writeKnownLatestVersion(
  path: string,
  newVersion: string,
): void;

export declare function readMinimumSupportedVersion(path: string): string;

export declare function fetchLatestVersion(): Promise<string>;
