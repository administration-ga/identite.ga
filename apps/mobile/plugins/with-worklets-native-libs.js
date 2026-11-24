const { withProjectBuildGradle } = require('expo/config-plugins');

// AGP 9 writes native outputs under cxx; Worklets 0.7 consumers still import
// intermediates/cmake. Copy the built library to that compatibility path.
const gradlePatch = `
// IDN Worklets native output compatibility
gradle.projectsEvaluated {
  def worklets = findProject(':react-native-worklets')
  if (worklets != null) {
    ['Debug', 'Release'].each { variant ->
      def merge = worklets.tasks.named("merge\u0024{variant}NativeLibs")
      merge.configure {
        doLast {
          copy {
            from(new File(worklets.buildDir, "intermediates/merged_native_libs/\u0024{variant.toLowerCase()}/merge\u0024{variant}NativeLibs/out/lib"))
            include '**/libworklets.so'
            into(new File(worklets.buildDir, "intermediates/cmake/\u0024{variant.toLowerCase()}/obj"))
          }
        }
      }
      [':react-native-reanimated', ':expo-modules-core'].each { name ->
        def consumer = findProject(name)
        if (consumer != null) {
          consumer.tasks.matching { it.name.startsWith(variant == 'Debug' ? 'buildCMakeDebug' : 'buildCMakeRelWithDebInfo') }.configureEach {
            dependsOn(merge)
          }
        }
      }
    }
  }
}
`;

module.exports = (config) => withProjectBuildGradle(config, (mod) => {
  if (!mod.modResults.contents.includes('// IDN Worklets native output compatibility')) {
    mod.modResults.contents += gradlePatch;
  }
  return mod;
});
module.exports.gradlePatch = gradlePatch;
