pluginManagement {
    repositories {
        // 本机网络实测 maven.google.com 不可达，dl.google.com 的制品库可达 —— 显式指定
        maven("https://dl.google.com/dl/android/maven2/")
        mavenCentral()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven("https://dl.google.com/dl/android/maven2/")
        mavenCentral()
    }
}
rootProject.name = "mymj-android-shell"
include(":app")
