//! A deterministic compute workload for the diagnostic benchmark: `fixture-bench <rounds>` runs an xorshift and FNV-1a
//! mix over a 1 MiB buffer `rounds` times and prints the checksum, so every placement can be checked for the same output.
fn main() {
    let rounds: u64 = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(50);
    let mut buffer = vec![0_u8; 1 << 20];
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for _ in 0..rounds {
        for byte in &mut buffer {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte ^= (state & 0xff) as u8;
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
        }
    }
    println!("checksum {hash:016x} rounds {rounds}");
}
