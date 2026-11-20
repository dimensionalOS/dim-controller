//! The picture size in an H.265 sequence parameter set.
//!
//! A passed-through access unit ([`bitstream::Bitstream::unit`](super::bitstream::Bitstream::unit)) is never
//! decoded, so nothing else knows how big its picture is: `foxglove_msgs/CompressedVideo` carries no size, and the
//! gateway reads the size off each encoded frame (it sets the stream's source size, the allocator's grant and the
//! per-frame metadata a page reads). So read it out of the SPS, which every keyframe carries in front of it.
//!
//! Only as much of the SPS as the size needs is parsed: everything up to `pic_height_in_luma_samples` and the
//! conformance window that crops it.

use anyhow::{Result, bail, ensure};

/// Bits of an SPS payload, with H.265's emulation-prevention bytes already gone.
pub(crate) struct Bits {
    /// the raw byte sequence payload (RBSP)
    bytes: Vec<u8>,
    /// how many bits have been read
    at: usize,
}

impl Bits {
    /// The RBSP of one NAL unit payload: every `0x03` that follows `0x00 0x00` is an emulation-prevention byte the
    /// encoder added so the bytes could not look like a start code, and is not part of the syntax.
    pub(crate) fn new(payload: &[u8]) -> Self {
        let mut bytes = Vec::with_capacity(payload.len());
        let mut zeros = 0;
        for &byte in payload {
            if zeros >= 2 && byte == 0x03 {
                zeros = 0;
                continue;
            }
            zeros = if byte == 0 { zeros + 1 } else { 0 };
            bytes.push(byte);
        }
        Bits { bytes, at: 0 }
    }

    /// `count` bits, most significant first; fails past the end rather than reading zeros, so a truncated SPS says so
    /// instead of giving a plausible size.
    pub(crate) fn bits(&mut self, count: usize) -> Result<u64> {
        ensure!(count <= 64, "{count} bits at once");
        ensure!(self.at + count <= self.bytes.len() * 8, "the sequence parameter set ends after {} bits, needed {}", self.bytes.len() * 8, self.at + count);
        let mut value = 0u64;
        for _ in 0..count {
            let byte = self.bytes[self.at / 8];
            value = (value << 1) | ((byte >> (7 - self.at % 8)) & 1) as u64;
            self.at += 1;
        }
        Ok(value)
    }

    /// One bit as a flag.
    pub(crate) fn flag(&mut self) -> Result<bool> {
        Ok(self.bits(1)? == 1)
    }

    /// An unsigned exp-Golomb code (`ue(v)`): the leading zeros say how many bits follow.
    pub(crate) fn ue(&mut self) -> Result<u64> {
        let mut leading = 0;
        while !self.flag()? {
            leading += 1;
            // 32 leading zeros is already past any size a picture can have: a desynced reader, not a huge number
            ensure!(leading <= 32, "the sequence parameter set is not exp-Golomb here ({leading} leading zeros)");
        }
        Ok((1u64 << leading) - 1 + self.bits(leading)?)
    }

    /// A signed exp-Golomb code (`se(v)`): maps the unsigned code k to 0, +1, -1, +2, -2, …
    pub(crate) fn se(&mut self) -> Result<i64> {
        let k = self.ue()?;
        Ok(if k % 2 == 1 { ((k + 1) / 2) as i64 } else { -((k / 2) as i64) })
    }

    /// `profile_tier_level`, which sits between the sub-layer count and the sizes and is skipped whole.
    fn skip_profile_tier_level(&mut self, max_sub_layers_minus1: u64) -> Result<()> {
        // general_profile_space(2) .. general_reserved_zero_43bits(43), general_inbld_flag(1), general_level_idc(8)
        self.bits(32)?;
        self.bits(32)?;
        self.bits(32)?;
        let mut present = Vec::with_capacity(max_sub_layers_minus1 as usize);
        for _ in 0..max_sub_layers_minus1 {
            present.push((self.flag()?, self.flag()?));
        }
        if max_sub_layers_minus1 > 0 {
            for _ in max_sub_layers_minus1..8 {
                self.bits(2)?;
            }
        }
        for (profile, level) in present {
            if profile {
                self.bits(32)?;
                self.bits(32)?;
                self.bits(24)?;
            }
            if level {
                self.bits(8)?;
            }
        }
        Ok(())
    }
}

/// The cropped picture size (width, height) in an H.265 SPS NAL unit, `payload` being the unit without its Annex-B start
/// code (so its two header bytes come first).
pub fn picture_size(payload: &[u8]) -> Result<(u32, u32)> {
    ensure!(payload.len() > 2, "an H.265 SPS is {} bytes", payload.len());
    let kind = (payload[0] >> 1) & 0x3f;
    ensure!(kind == 33, "NAL unit type {kind} is not an H.265 SPS (33)");
    let mut bits = Bits::new(&payload[2..]);
    // sps_video_parameter_set_id(4), sps_max_sub_layers_minus1(3), sps_temporal_id_nesting_flag(1)
    bits.bits(4)?;
    let max_sub_layers_minus1 = bits.bits(3)?;
    bits.flag()?;
    bits.skip_profile_tier_level(max_sub_layers_minus1)?;
    bits.ue()?; // sps_seq_parameter_set_id
    let chroma_format_idc = bits.ue()?;
    if chroma_format_idc == 3 {
        bits.flag()?; // separate_colour_plane_flag
    }
    let width = bits.ue()?;
    let height = bits.ue()?;
    // what one chroma sample covers, which is what a conformance window offset counts in
    let (sub_width, sub_height) = match chroma_format_idc {
        // monochrome and 4:4:4 are sampled like luma; 4:2:2 is halved across, 4:2:0 both ways
        0 | 3 => (1, 1),
        1 => (2, 2),
        2 => (2, 1),
        other => bail!("chroma_format_idc {other} is not 0-3"),
    };
    let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
    if bits.flag()? {
        (left, right, top, bottom) = (bits.ue()?, bits.ue()?, bits.ue()?, bits.ue()?);
    }
    let cropped_width = width.checked_sub(sub_width * (left + right));
    let cropped_height = height.checked_sub(sub_height * (top + bottom));
    let (Some(cropped_width), Some(cropped_height)) = (cropped_width, cropped_height) else {
        bail!("an H.265 conformance window crops {width}x{height} away ({left}/{right}/{top}/{bottom})");
    };
    ensure!(cropped_width > 0 && cropped_height > 0 && cropped_width <= 16_384 && cropped_height <= 16_384, "an H.265 SPS says the picture is {cropped_width}x{cropped_height}");
    Ok((cropped_width as u32, cropped_height as u32))
}

