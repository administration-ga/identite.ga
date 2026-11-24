const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/**
 * Force IPHONEOS_DEPLOYMENT_TARGET à 15.1 sur TOUS les targets de pods (y compris
 * les resource/privacy bundles : *_Privacy, *-resources, etc.).
 *
 * POURQUOI : les Xcode récents refusent tout target < iOS 15.0. Or plusieurs pods
 * (Firebase*, GoogleUtilities, nanopb, PromisesObjC, SDWebImage, ReachabilitySwift,
 * RNSVG, RNCAsyncStorage…) déclarent 9.0/12.0/13.x dans leur podspec, et
 * `expo-build-properties.ios.deploymentTarget` ne propage pas jusqu'aux bundles
 * auto-générés → "deployment target is set to 12.0, supported range is 15.0…".
 *
 * On injecte une boucle en tête du `post_install` existant du Podfile Expo (avant
 * `react_native_post_install`). Idempotent (marqueur).
 *
 * NB : garder `DEPLOYMENT_TARGET` >= au plancher iOS de l'app (voir
 * `expo-build-properties.ios.deploymentTarget` dans app.json) ET >= au plancher
 * d'Expo SDK 57, qui est **iOS 16.4** (SDK 54 était 15.1). Les deux valeurs
 * doivent rester alignées.
 */
const DEPLOYMENT_TARGET = "16.4";
const MARKER = "withIosDeploymentTarget";

/**
 * Aligne aussi la cible de l'app elle-même : le modèle Expo la laisse à 15.1,
 * alors que les modules Expo 57 exigent 16.4 (« compiling for iOS 15.1, but
 * module 'Expo' has a minimum deployment target of iOS 16.4 »).
 */
const withAppDeploymentTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key] && configurations[key].buildSettings;
      if (settings && settings.IPHONEOS_DEPLOYMENT_TARGET !== undefined) {
        settings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
      }
    }
    return cfg;
  });

const withIosDeploymentTarget = (config) =>
  withDangerousMod(withAppDeploymentTarget(config), [
    "ios",
    (cfg) => {
      const podfilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        "Podfile"
      );
      let contents = fs.readFileSync(podfilePath, "utf8");
      if (
        !contents.includes(MARKER) &&
        /post_install do \|installer\|/.test(contents)
      ) {
        const injection =
          `post_install do |installer|\n` +
          `    # [${MARKER}] Force le deployment target de tous les pods (+ bundles) à ${DEPLOYMENT_TARGET}\n` +
          `    # (Xcode récent refuse < 15.0 ; les resource/privacy bundles ne sont pas couverts par expo-build-properties).\n` +
          `    installer.pods_project.targets.each do |t|\n` +
          `      t.build_configurations.each do |bc|\n` +
          `        bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${DEPLOYMENT_TARGET}'\n` +
          `      end\n` +
          `    end\n`;
        contents = contents.replace(
          /post_install do \|installer\|\n/,
          injection
        );
        fs.writeFileSync(podfilePath, contents, "utf8");
      }
      return cfg;
    },
  ]);

module.exports = withIosDeploymentTarget;
