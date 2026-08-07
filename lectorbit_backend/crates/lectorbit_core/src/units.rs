use serde::{Deserialize, Serialize};

macro_rules! unit_newtype {
    ($name:ident, $inner:ty, $doc:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        #[doc = $doc]
        pub struct $name(pub $inner);

        impl $name {
            pub const ZERO: Self = Self(0);
        }
    };
}

unit_newtype!(Seconds, u64, "Duration in whole seconds.");
unit_newtype!(Milliseconds, u64, "Duration in milliseconds.");
unit_newtype!(Minutes, u32, "Duration in whole minutes.");
unit_newtype!(Bytes, u64, "Size in bytes.");