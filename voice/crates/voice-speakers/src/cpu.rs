//! The processor features the portable NeMo-Speech.cpp build needs. Its ggml CPU backend is
//! compiled for an AVX2 baseline, which under MSVC also turns on FMA and F16C, plus BMI2 by hand.
//! Loading it on a processor without them crashes the process instead of returning an error, so
//! the worker checks before it loads anything. voice-core runs the same check before it starts the
//! worker.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CpuFeatures {
    pub avx2: bool,
    pub fma: bool,
    pub f16c: bool,
    pub bmi2: bool,
}

/// This processor's features; all false off x86-64. `is_x86_feature_detected!` also checks that
/// the operating system saves the AVX registers.
pub fn detect() -> CpuFeatures {
    #[cfg(target_arch = "x86_64")]
    {
        CpuFeatures {
            avx2: std::arch::is_x86_feature_detected!("avx2"),
            fma: std::arch::is_x86_feature_detected!("fma"),
            f16c: std::arch::is_x86_feature_detected!("f16c"),
            bmi2: std::arch::is_x86_feature_detected!("bmi2"),
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        CpuFeatures::default()
    }
}

impl CpuFeatures {
    /// The names of the missing features, in a fixed order; empty when the runtime can run.
    pub fn missing(&self) -> Vec<&'static str> {
        [
            ("avx2", self.avx2),
            ("fma", self.fma),
            ("f16c", self.f16c),
            ("bmi2", self.bmi2),
        ]
        .into_iter()
        .filter(|(_, present)| !present)
        .map(|(name, _)| name)
        .collect()
    }

    /// The message for a processor that can't run the runtime, or `None` when it can.
    pub fn refusal(&self) -> Option<String> {
        let missing = self.missing();
        if missing.is_empty() {
            return None;
        }
        Some(format!("This processor lacks {}.", list(&missing)))
    }
}

fn list(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: CpuFeatures = CpuFeatures {
        avx2: true,
        fma: true,
        f16c: true,
        bmi2: true,
    };

    #[test]
    fn a_complete_processor_is_not_refused() {
        assert!(ALL.missing().is_empty());
        assert_eq!(ALL.refusal(), None);
    }

    #[test]
    fn missing_features_are_named_in_order() {
        let no_bmi2 = CpuFeatures { bmi2: false, ..ALL };
        assert_eq!(no_bmi2.missing(), ["bmi2"]);
        assert_eq!(
            no_bmi2.refusal().as_deref(),
            Some("This processor lacks bmi2.")
        );

        let old = CpuFeatures {
            avx2: false,
            fma: false,
            ..ALL
        };
        assert_eq!(
            old.refusal().as_deref(),
            Some("This processor lacks avx2 and fma.")
        );
        assert_eq!(
            CpuFeatures::default().refusal().as_deref(),
            Some("This processor lacks avx2, fma, f16c and bmi2.")
        );
    }

    #[test]
    fn serializes_as_four_flags() {
        assert_eq!(
            serde_json::to_value(ALL).unwrap(),
            serde_json::json!({"avx2": true, "fma": true, "f16c": true, "bmi2": true})
        );
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn detection_agrees_with_the_standard_library() {
        let detected = detect();
        assert_eq!(detected.avx2, std::arch::is_x86_feature_detected!("avx2"));
        assert_eq!(detected.bmi2, std::arch::is_x86_feature_detected!("bmi2"));
    }
}
