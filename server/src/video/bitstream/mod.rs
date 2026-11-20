//! One coded picture of any video bitstream, read the same way whatever codec wrote it.
//!
//! The gateway's video path has two jobs for a sample that arrives already encoded: **forward** it, when the track the
//! browser negotiated wants the same format the publisher sent, or **decode** it, when it does not. Both jobs need the
//! same four things read off the bytes without decoding them — where the coded pictures are, whether this one is a
//! keyframe, how big the picture is, and which bytes let a decoder start — and every codec answers them differently
//! enough that the old code answered them per codec and had no place to put a third.
//!
//! So each bitstream reads itself ([`Bitstream`]) and they all produce the same [`Unit`]. Adding a codec is one impl and
//! one line of [`ALL`]; nothing else in the crate branches on which codec a stream is.
//!
//! The piece worth naming is [`Unit::headers`]: H.264 and H.265 put the bytes a decoder must have first in *parameter
//! sets* (SPS/PPS, and H.265's VPS), AV1 puts them in a *sequence header OBU*. They are differently shaped and
//! differently found, but they play one part — and once a `Unit` carries them under one name, the rule that matters
//! ([`decodable`]: remember them, and put them back in front of a keyframe that arrives without them) is written once
//! for every codec instead of once per codec.

mod annex_b;
mod obu;

use anyhow::{Result, ensure};
use crate::video::VideoFormat;

pub use annex_b::{H264, H265};
pub use obu::AV1;

/// One coded picture as the publisher sent it, and what can be told about it without decoding it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    /// which bitstream `data` is
    pub format: VideoFormat,
    /// the bytes to forward or to decode, normalised for the RTP packetizer this feeds (see [`Bitstream::unit`])
    pub data: Vec<u8>,
    /// a picture a decoder can start at, given [`headers`](Self::headers)
    pub keyframe: bool,
    /// the bytes that let a decoder start, when this unit carries them: H.26x parameter sets (VPS/SPS/PPS), AV1's
    /// sequence header OBU. A keyframe that arrives without them is only decodable once they are put back in front of
    /// it ([`decodable`]).
    pub headers: Option<Vec<u8>>,
    /// the picture size, when this unit carries the headers that say what it is
    pub size: Option<(u32, u32)>,
}

/// How one video bitstream reads itself.
///
/// The impls are unit structs ([`H264`], [`H265`], [`AV1`]) because a bitstream has no state: what state there is
/// belongs to a *stream* of units (the remembered headers and size), and lives in whoever is reading one.
pub trait Bitstream: Send + Sync {
    /// The format of the units it reads.
    fn format(&self) -> VideoFormat;

    /// The `format` strings a publisher may write for it, lowercase (`foxglove_msgs/CompressedVideo`'s field, and the
    /// same string in dimos' LCM message). The first is the canonical one.
    fn names(&self) -> &'static [&'static str];

    /// What this bitstream calls the bytes a decoder must have to start, for an error message that names the thing the
    /// publisher has to send: `"VPS/SPS/PPS"`, `"a sequence header OBU"`.
    fn headers_called(&self) -> &'static str;

    /// Reads one coded picture.
    ///
    /// The `data` handed back is **normalised for the packetizer**, not necessarily the bytes that arrived: H.26x
    /// re-emits every NAL unit behind a four-byte start code (the RTP payloader reads every start code at the width of
    /// the first four-byte one it finds, so a unit mixing widths has NAL units merged), and AV1 drops the temporal
    /// delimiter (RTP's AV1 payload format does not carry one). Both are one copy and remove a class of bug that only
    /// shows as a broken picture.
    fn unit(&self, data: &[u8]) -> Result<Unit>;

    /// The unit types in `data`, in order — NAL types for H.26x, OBU types for AV1 — for an error message. Reading
    /// these must not fail: a buffer too broken to read is reported as an empty list, since this is only ever called to
    /// explain some other failure.
    fn unit_types(&self, data: &[u8]) -> Vec<u8>;

    /// What those types are called, for the same error message: `"NAL types"`, `"OBU types"`.
    fn types_called(&self) -> &'static str;

    /// Decodes one unit with a decoder of its own — the per-sample path, which has no earlier frame to predict from.
    /// [`check_decodable_alone`] is what says first, and in the publisher's terms, why a sample cannot be one.
    ///
    /// This is here rather than in a match somewhere above so that nothing outside these impls has to know which codec
    /// a stream is: that is the whole bargain of the trait, and a per-sample decode is the one place the old code still
    /// branched on it.
    fn decode_alone(&self, data: &[u8]) -> Result<crate::video::VideoImage>;
}

/// Every bitstream this crate reads. One line per codec; nothing else enumerates them.
pub static ALL: &[&'static dyn Bitstream] = &[&H264, &H265, &AV1];

/// The bitstream a publisher's `format` string names (`"h264"`, `"hevc"`, `"av01"`; case and padding do not matter).
pub fn by_name(format: &str) -> Result<&'static dyn Bitstream> {
    let wanted = format.trim().to_ascii_lowercase();
    ALL.iter()
        .find(|bitstream| bitstream.names().contains(&wanted.as_str()))
        .copied()
        .ok_or_else(|| anyhow::anyhow!("video format {format:?} is not one this reads ({})", known_names().join(", ")))
}

/// The bitstream that reads `format`'s units, where this crate reads it.
pub fn of(format: VideoFormat) -> Option<&'static dyn Bitstream> {
    ALL.iter().find(|bitstream| bitstream.format() == format).copied()
}

/// Every `format` string [`by_name`] accepts, for its error message.
fn known_names() -> Vec<&'static str> {
    ALL.iter().flat_map(|bitstream| bitstream.names().iter().copied()).collect()
}

/// Fails, saying why, unless `data` decodes with no other sample: a keyframe carrying its own headers.
///
/// This is the per-sample path's requirement, not a stream's. The gateway decodes only the samples it sends, so a
/// decoder built for one sample has no earlier frame to predict from and no remembered headers — which is why a
/// publisher sending predicted frames showed one picture a second until [`StreamDecoder`](crate::video::StreamDecoder)
/// existed.
pub fn check_decodable_alone(bitstream: &dyn Bitstream, data: &[u8]) -> Result<()> {
    let unit = bitstream.unit(data)?;
    let types = bitstream.unit_types(data);
    let (types_called, each) = (bitstream.types_called(), "each sample is decoded on its own");
    ensure!(unit.keyframe, "{:?} sample isn't a keyframe ({types_called} {types:?}): {each}, so the publisher must send keyframes only", unit.format);
    ensure!(
        unit.headers.is_some(),
        "{:?} keyframe has no {} ({types_called} {types:?}): {each}, so the publisher must put them in front of every keyframe",
        unit.format,
        bitstream.headers_called()
    );
    Ok(())
}

/// The bytes a decoder can be handed for `unit`, and whether it can start from them.
///
/// `remembered` is the newest headers this stream has seen, which this updates. A camera's own stream often carries
/// none in band at all — on the M20 the only ones anybody sees are the extradata its publisher prepends to a keyframe —
/// so a consumer that joined between one keyframe and the next has nothing to start from unless they are put back.
///
/// One function for every codec: that is what [`Unit::headers`] buys. H.26x parameter sets concatenate in front of an
/// access unit and an AV1 sequence header OBU concatenates in front of a temporal unit, so "put the headers back" is
/// the same operation on both once the bytes are named rather than typed.
pub fn decodable(unit: &Unit, remembered: &mut Option<Vec<u8>>) -> (Vec<u8>, bool) {
    if let Some(carried) = &unit.headers {
        *remembered = Some(carried.clone());
    }
    match (unit.keyframe, unit.headers.is_none(), remembered.as_ref()) {
        // a keyframe without its headers, and some remembered: put them in front and it decodes on its own
        (true, true, Some(headers)) => ([headers.as_slice(), unit.data.as_slice()].concat(), true),
        // a keyframe that carries its own, or one with none to be had (nothing can start from that), or any other frame
        (keyframe, _, headers) => (unit.data.clone(), keyframe && headers.is_some()),
    }
}

/// Whether a source bitstream's units can go to a `track` as they are, rather than being decoded and encoded again.
///
/// **Passing through is a property of the pair, not of either format.** The old rule asked the track format alone
/// ([`VideoFormat::passthrough_only`], true for H.265 and nothing else), which could only ever express "this format is
/// never encoded here" — so an H.264 camera watched on an H.264 track was decoded and re-encoded for no reason, and an
/// AV1 camera on an AV1 track would have been too. What actually decides it is whether the two formats are the same.
pub fn passes_through(source: VideoFormat, track: VideoFormat) -> bool {
    source == track
}

/// Reads `data` as `format`'s units, naming the format in the error if it is not one this crate reads.
pub fn unit_of(format: &str, data: &[u8]) -> Result<Unit> {
    by_name(format)?.unit(data)
}

// There is deliberately no "can this track be served?" asked of a channel on its own. Whether it can depends on the
// source as well, which is not known until a sample arrives, and on whether the *server* installed an encoder of that
// format (`ServerBuilder::video_encoder`), which an encoding cannot see. Refusing a subscription from here would
// therefore turn a working path into a closed one. The pair is named where it is known, in the stream decoder.

