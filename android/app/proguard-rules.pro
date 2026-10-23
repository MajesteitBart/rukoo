# kotlinx.serialization keeps generated serializers through its bundled consumer rules.
# commonmark uses reflection-free visitors; nothing extra to keep.

# Angus Mail finds its protocol providers and data handlers by class name from META-INF files.
-keep class org.eclipse.angus.mail.** { *; }
-keep class org.eclipse.angus.activation.** { *; }
-keep class jakarta.mail.** { *; }
-keep class jakarta.activation.** { *; }
-dontwarn java.awt.**
-dontwarn javax.security.sasl.**
-dontwarn javax.naming.**
-dontwarn org.eclipse.angus.**

-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
