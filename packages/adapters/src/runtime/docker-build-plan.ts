import type { BuildConfig } from "../types";
import { getDockerBuildRecipe, resolveRuntimeImages, assertRuntimeVersionTarget } from "@repo/core";
import { generatePhpDockerfile } from "./docker-recipes/php";
import { generateRubyDockerfile } from "./docker-recipes/ruby";
import { generateStaticDockerfile } from "./docker-recipes/static";
import { generateGenericDockerfile } from "./docker-recipes/generic";

export {
  builderContextRoot,
  isExcludedDocRootEntry,
  staticBuilderOutputPath,
} from "./docker-recipes/static";

const recipes = {
  php: generatePhpDockerfile,
  ruby: generateRubyDockerfile,
  static: generateStaticDockerfile,
  generic: generateGenericDockerfile,
};

export function generateDockerfile(config: BuildConfig): string {
  assertRuntimeVersionTarget({
    runtimeVersion: config.runtimeVersion,
    runtimeImage: config.runtimeImageOverride ? config.runtimeImage : undefined,
    framework: config.stack,
    workloadType: config.isStatic ? "static" : "web",
    buildKind: config.dockerfilePath || config.dockerfileContent ? "dockerfile" : undefined,
  });
  if (config.runtimeVersion != null) {
    resolveRuntimeImages(
      config.stack,
      config.runtimeVersion,
      config.buildImage,
      config.runtimeImage,
    );
  }
  const recipe = recipes[getDockerBuildRecipe(config.stack, config.isStatic)](config);
  if (!config.buildCache) return recipe;
  // Automatic platform args need declaring in each stage for mount ID expansion.
  return recipe.replace(/^(FROM .+)$/gm, "$1\nARG TARGETPLATFORM");
}
