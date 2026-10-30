// EMETH Companion — Paper plugin: an in-game window into the mind of the EMETH agent.
//   ./gradlew build        → build/libs/emeth-companion-<version>.jar (drop it in the server's plugins/)
//   ./gradlew test         → unit tests (parses the shared control fixtures in ../protocol/fixtures/control)
plugins {
    java
}

group = "dev.emeth"
version = "0.1.0"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

repositories {
    // PaperMC's group repository also proxies Maven Central.
    maven("https://repo.papermc.io/repository/maven-public/")
}

val paperApi = "io.papermc.paper:paper-api:1.21.11-R0.1-SNAPSHOT"

dependencies {
    compileOnly(paperApi)
    testImplementation(paperApi)
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(21)
    options.compilerArgs.addAll(listOf("-Xlint:all", "-Xlint:-processing", "-Xlint:-serial", "-Werror"))
}

tasks.processResources {
    val props = mapOf("version" to project.version)
    inputs.properties(props)
    filesMatching("plugin.yml") { expand(props) }
}

tasks.test {
    useJUnitPlatform()
    systemProperty("emeth.fixtures", rootDir.resolve("../protocol/fixtures/control").absolutePath)
    systemProperty("java.awt.headless", "true")
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
