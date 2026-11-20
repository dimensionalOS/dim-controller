//! AV1, whose coded pictures are OBUs rather than Annex-B NAL units: a temporal unit is a run of OBUs that each carry
//! their own size, so reading one is exact rather than a search for start codes. The reading itself lives in
//! [`utils::av1`](crate::video::av1); this is what makes it one of the [`Bitstream`]s.

use super::{Bitstream, Unit};
use crate::video::av1;
use anyhow::Result;
use crate::video::VideoFormat;

/// AV1, temporal units in the low-overhead bitstream format.
pub struct AV1;

impl Bitstream for AV1 {
    fn format(&self) -> VideoFormat {
        VideoFormat::Av1
    }

    /// `"av01"` is what the ISO-BMFF/WebCodecs world calls it and it does turn up in publishers' `format` fields, so it
    /// is accepted beside the plain name rather than left to fail as an unknown codec.
    fn names(&self) -> &'static [&'static str] {
        &["av1", "av01"]
    }

    fn headers_called(&self) -> &'static str {
        "sequence header OBU"
    }

    fn unit(&self, data: &[u8]) -> Result<Unit> {
        let read = av1::temporal_unit(data)?;
        Ok(Unit { format: VideoFormat::Av1, data: read.data, keyframe: read.keyframe, headers: read.sequence_header, size: read.size })
    }

    fn unit_types(&self, data: &[u8]) -> Vec<u8> {
        av1::obus(data).map(|obus| obus.iter().map(|obu| obu.kind).collect()).unwrap_or_default()
    }

    fn types_called(&self) -> &'static str {
        "OBU types"
    }

    fn decode_alone(&self, data: &[u8]) -> Result<crate::video::VideoImage> {
        av1::decode(data)
    }
}

