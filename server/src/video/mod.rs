//! One picture out of a compressed video stream (foxglove `CompressedVideo`: H.264, H.265, AV1), for a camera snapshot.
//! The decoders are zenoh-dimos-codecs 0.3.15's (`src/utils`, tests left there), copied because that crate can't be a
//! dependency: it brings zenoh-gateway, and with it another zenoh. H.264 is openh264 (built in), AV1 rav1d (pure Rust),
//! H.265 libde265 loaded at runtime (no maintained Rust decoder; the gateway loads the same one).
#![allow(dead_code)]

mod av1;
mod av1_seq;
mod bitstream;
mod compressed_video;
mod h264;
mod h264_sps;
mod h265;
mod h265_sps;

use anyhow::{ensure, Result};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VideoFormat {
    H264,
    H265,
    Av1,
}

/// An 8-bit I420 picture: the Y plane, then U and V at half size.
#[derive(Debug)]
pub struct VideoImage {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl VideoImage {
    pub fn i420(width: u32, height: u32, data: Vec<u8>) -> Result<Self> {
        let (columns, rows) = (width as usize, height as usize);
        ensure!(width % 2 == 0 && height % 2 == 0 && data.len() == columns * rows * 3 / 2, "not an I420 picture of {width}x{height}");
        Ok(VideoImage { width, height, data })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// RGB8, BT.601 limited range (what camera encoders write unless they say otherwise).
    pub fn to_rgb(&self) -> Vec<u8> {
        let (width, height) = (self.width as usize, self.height as usize);
        let (luma, chroma) = self.data.split_at(width * height);
        let (u_plane, v_plane) = chroma.split_at(width * height / 4);
        let mut rgb = Vec::with_capacity(width * height * 3);
        for row in 0..height {
            for column in 0..width {
                let chroma_at = (row / 2) * (width / 2) + column / 2;
                let y = (luma[row * width + column] as f32 - 16.0) * 1.164;
                let (u, v) = (u_plane[chroma_at] as f32 - 128.0, v_plane[chroma_at] as f32 - 128.0);
                for value in [y + 1.596 * v, y - 0.392 * u - 0.813 * v, y + 2.017 * u] {
                    rgb.push(value.round().clamp(0.0, 255.0) as u8);
                }
            }
        }
        rgb
    }
}

/// Reads a stream's samples in order until one decodes on its own: the next keyframe, with the newest headers
/// (parameter sets, sequence header) put back in front when it arrives without them.
#[derive(Default)]
pub struct Still {
    headers: Option<Vec<u8>>,
}

impl Still {
    /// The picture in this sample of `format` (`h264`, `h265`/`hevc`, `av1`), or None for one that can't start a decode.
    pub fn push(&mut self, data: &[u8], format: &str) -> Result<Option<VideoImage>> {
        let unit = bitstream::unit_of(format, data)?;
        let (bytes, keyframe) = bitstream::decodable(&unit, &mut self.headers);
        if !keyframe {
            return Ok(None);
        }
        bitstream::by_name(format)?.decode_alone(&bytes).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!("{}/src/video/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    /// The pattern fixtures are 320x240.
    fn assert_pattern(image: &VideoImage, what: &str) {
        assert_eq!((image.width(), image.height()), (320, 240), "{what}");
        let rgb = image.to_rgb();
        assert_eq!(rgb.len(), 320 * 240 * 3, "{what}");
    }

    #[test]
    fn a_keyframe_of_each_codec_decodes() {
        for (format, file) in [("h264", "pattern.h264"), ("av1", "pattern.av1"), ("h265", "pattern.h265")] {
            if format == "h265" && h265::decode(&fixture(file)).is_err() {
                eprintln!("no libde265 here: H.265 not tested");
                continue;
            }
            let image = Still::default().push(&fixture(file), format).unwrap().expect(format);
            assert_pattern(&image, format);
        }
    }

    #[test]
    fn the_m20s_own_keyframe_decodes() {
        let data = fixture("m20_front_keyframe.h265");
        if h265::decode(&data).is_err() {
            eprintln!("no libde265 here: H.265 not tested");
            return;
        }
        let image = Still::default().push(&data, "h265").unwrap().expect("a keyframe");
        assert!(image.width() > 0 && image.height() > 0);
    }

    #[test]
    fn a_keyframe_without_headers_takes_the_remembered_ones() {
        let mut still = Still::default();
        assert!(still.push(&fixture("pattern_bare.av1"), "av1").unwrap().is_none(), "nothing to start from yet");
        assert_pattern(&still.push(&fixture("pattern.av1"), "av1").unwrap().unwrap(), "with headers");
        assert_pattern(&still.push(&fixture("pattern_bare.av1"), "av1").unwrap().unwrap(), "headers put back");
    }
}
