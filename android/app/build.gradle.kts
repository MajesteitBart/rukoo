import java.util.Properties
import javax.inject.Inject
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release builds are signed with a local keystore described in signing.properties (git-ignored).
// Without it, release falls back to the debug key so `assembleRelease` still works on a fresh checkout.
val signingProps = Properties().apply {
    val file = rootProject.file("signing.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

// Push wakes through Google's FCM for phones without a UnifiedPush app (workspaces/ChatPush.kt, docs/android.md): the
// embedded distributor registers with Google Play services under the account server's VAPID key, so it needs no
// Firebase project, no google-services.json and no gateway. A build for a store that takes no Google services, such as
// F-Droid, leaves it out with -Prukoo.fcm=off; such a build gets wakes only through a UnifiedPush app.
val embeddedFcm = providers.gradleProperty("rukoo.fcm").orElse("on").get() != "off"

android {
    namespace = "nl.bvdm.rukoo"
    compileSdk = 36

    defaultConfig {
        applicationId = "nl.bvdm.rukoo"
        minSdk = 31
        targetSdk = 36
        versionCode = 7
        versionName = "0.6.0"
        // The in-memory preview mail engine and agent hub stand in until the real ones land; the mail and
        // agent tracks turn these off (debug builds can keep the preview for screenshots).
        buildConfigField("boolean", "USE_PREVIEW_MAIL", "false")
        buildConfigField("boolean", "USE_PREVIEW_AGENTS", "false")
        // The Rukoo account server the app uses until someone picks another in Settings (docs/account.md). A fork
        // points its builds at its own server here.
        buildConfigField("String", "ACCOUNT_SERVER", "\"https://rukoo.io\"")
        // For the tests that need the phone's own TLS (src/androidTest): ./gradlew connectedDebugAndroidTest.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (signingProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/versions/9/previous-compilation-data.bin",
            "META-INF/LICENSE.md",
            "META-INF/NOTICE.md",
        )
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// The live tests (AccountLiveTest, WorkspaceLiveTest) run against the server RUKOO_ACCOUNT_TEST_SERVER names and skip
// without it; RUKOO_ACCOUNT_TEST_INVITE and RUKOO_ACCOUNT_TEST_NODE turn on more of their cases. Gradle doesn't see
// environment variables, so they are inputs here: a test task that ran without one isn't UP-TO-DATE once it is set
// (docs/development.md, "Team chat tests").
tasks.withType<Test>().configureEach {
    inputs.property("rukooAccountTestServer", System.getenv("RUKOO_ACCOUNT_TEST_SERVER").orEmpty())
    inputs.property("rukooAccountTestInvite", System.getenv("RUKOO_ACCOUNT_TEST_INVITE").orEmpty())
    inputs.property("rukooAccountTestNode", System.getenv("RUKOO_ACCOUNT_TEST_NODE").orEmpty())
}

// Rukoo's own skills (the repository's skills/ folder) ship in the APK's assets under skills/, so the phone
// offers the same /name skills as desktop Rukoo.
abstract class BundleSkills : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val skills: DirectoryProperty

    @get:OutputDirectory
    abstract val assets: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @TaskAction
    fun bundle() {
        files.sync {
            from(skills) { exclude("README.md") }
            into(assets.get().dir("skills").asFile)
        }
    }
}

val bundleSkills = tasks.register<BundleSkills>("bundleSkills") {
    skills.set(rootProject.layout.projectDirectory.dir("../skills"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(bundleSkills, BundleSkills::assets)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.window)
    // The team chat cache (workspaces/ChatDb.kt): the driver API, opened on the platform's SQLite in the app and on
    // the bundled SQLite in JVM unit tests, so the store's tests run real SQL transactions.
    implementation(libs.androidx.sqlite)
    implementation(libs.androidx.sqlite.framework)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.commonmark)
    implementation(libs.commonmark.ext.gfm.tables)
    implementation(libs.commonmark.ext.gfm.strikethrough)
    implementation(libs.autolink)
    implementation(libs.angus.mail)
    implementation(libs.angus.activation)
    implementation(libs.jsoup)
    // Argon2id for the Rukoo account's password key (account/AccountKeys.kt).
    implementation(libs.bouncycastle.prov)
    // Push wakes for team chat through a UnifiedPush distributor such as ntfy (workspaces/ChatPush.kt), and through
    // Google's FCM on a phone without one, unless the build leaves that out (embeddedFcm above).
    implementation(libs.unifiedpush.connector)
    if (embeddedFcm) implementation(libs.unifiedpush.fcm)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.androidx.sqlite.bundled.jvm)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.okhttp.tls)
}
