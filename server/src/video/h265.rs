//! H.265 decoding with rusty_h265: pure Rust (no C, no system library), so it decodes in the robots' static builds too.
//! Main and Main 10 (what camera encoders write); range extensions (4:4:4, 12-bit) are refused by name.

use super::compressed_video::i420_from_planes;
use crate::video::VideoImage;
use anyhow::{bail, Context, Result};

/// The first picture in an Annex-B access unit (with its parameter sets), as 8-bit I420.
pub fn decode(data: &[u8]) -> Result<VideoImage> {
    let mut decoder = rusty_h265::Decoder::new();
    decoder.push_annexb(data, None).map_err(|error| anyhow::anyhow!("rusty_h265: {error:?}"))?;
    decoder.flush();
    let frame = decoder.next_frame().ok().context("rusty_h265 decoded no picture from the access unit")?;
    let picture = &frame.picture;
    let (left, top, width, height) = picture.crop;
    // 10-bit pictures down to 8
    let eight_bit = |index: usize, column_shift: usize, row_shift: usize, depth: u8| -> (Vec<u8>, usize) {
        let plane = &picture.planes[index];
        let (columns, rows) = (width.div_ceil(1 << column_shift), height.div_ceil(1 << row_shift));
        let (first_column, first_row) = (left >> column_shift, top >> row_shift);
        let shift = depth.saturating_sub(8);
        let mut out = Vec::with_capacity(columns * rows);
        for row in first_row..first_row + rows {
            let start = row * plane.stride + first_column;
            out.extend(plane.data[start..start + columns].iter().map(|sample| (sample >> shift).min(255) as u8));
        }
        (out, columns)
    };
    match picture.chroma_format_idc {
        1 => {
            let (y, u, v) = (
                eight_bit(0, 0, 0, picture.bit_depth_luma),
                eight_bit(1, 1, 1, picture.bit_depth_chroma),
                eight_bit(2, 1, 1, picture.bit_depth_chroma),
            );
            i420_from_planes(width, height, [(&y.0, y.1), (&u.0, u.1), (&v.0, v.1)])
        }
        0 => {
            let y = eight_bit(0, 0, 0, picture.bit_depth_luma);
            let grey = vec![128; width.div_ceil(2) * height.div_ceil(2)];
            i420_from_planes(width, height, [(&y.0, y.1), (&grey, width.div_ceil(2)), (&grey, width.div_ceil(2))])
        }
        other => bail!("H.265 picture has chroma format {other} (4:2:0 or monochrome only)"),
    }
}
