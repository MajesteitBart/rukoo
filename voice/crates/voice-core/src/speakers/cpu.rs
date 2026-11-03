//! The processor features the portable NeMo-Speech.cpp build needs (AVX2 baseline with FMA, F16C
//! and BMI2). The app checks them before it starts a worker, and the worker again before it loads
//! the runtime.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CpuFeatures {
    pub avx2: bool,
    pub fma: bool,
    pub f16c: bool,
    pub bmi2: bool,
}

/// This processor's features; all false off x86-64.
pub fn cpu_features() -> CpuFeatures {
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
}
