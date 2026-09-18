plugins {
    id("com.android.application")
}

android {
    namespace = "com.mianyang.mahjong.shell"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.mianyang.mahjong"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-debug"
        // WebView 壳默认加载的线上入口（服务端 /app 路由 = LayaAir web 构建产物）。
        // 可被 AndroidManifest.xml <application> 里的 meta-data app_url 覆盖，不必重新编译。
        buildConfigField("String", "DEFAULT_APP_URL", "\"https://0106.wiki/app\"")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 内测阶段 debug 签名兜底；正式发布再换独立签名密钥。
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// 壳只用 android.* 框架 API（WebView / Activity），刻意不引任何 AndroidX / Kotlin 依赖，
// 把依赖面和构建失败面压到最小。
dependencies {
}
