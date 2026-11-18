;; int8 dot products for brute-force vector search, WebAssembly SIMD.
;; dots(mat, q, n, d, out): out[r] = sum_j mat[r*d + j] * q[j]  (int8 x int8 -> int32), d % 16 == 0
(module
  (memory (export "mem") 1 256)
  (func (export "dots") (param $mat i32) (param $q i32) (param $n i32) (param $d i32) (param $out i32)
    (local $r i32) (local $j i32) (local $row i32) (local $acc v128) (local $m v128) (local $qv v128)
    (block $done
      (loop $rows
        (br_if $done (i32.ge_u (local.get $r) (local.get $n)))
        (local.set $acc (v128.const i32x4 0 0 0 0))
        (local.set $row (i32.add (local.get $mat) (i32.mul (local.get $r) (local.get $d))))
        (local.set $j (i32.const 0))
        (block $rowdone
          (loop $cols
            (br_if $rowdone (i32.ge_u (local.get $j) (local.get $d)))
            (local.set $m (v128.load (i32.add (local.get $row) (local.get $j))))
            (local.set $qv (v128.load (i32.add (local.get $q) (local.get $j))))
            (local.set $acc
              (i32x4.add (local.get $acc)
                (i32x4.add
                  (i32x4.dot_i16x8_s (i16x8.extend_low_i8x16_s (local.get $m)) (i16x8.extend_low_i8x16_s (local.get $qv)))
                  (i32x4.dot_i16x8_s (i16x8.extend_high_i8x16_s (local.get $m)) (i16x8.extend_high_i8x16_s (local.get $qv))))))
            (local.set $j (i32.add (local.get $j) (i32.const 16)))
            (br $cols)))
        (i32.store
          (i32.add (local.get $out) (i32.shl (local.get $r) (i32.const 2)))
          (i32.add
            (i32.add (i32x4.extract_lane 0 (local.get $acc)) (i32x4.extract_lane 1 (local.get $acc)))
            (i32.add (i32x4.extract_lane 2 (local.get $acc)) (i32x4.extract_lane 3 (local.get $acc)))))
        (local.set $r (i32.add (local.get $r) (i32.const 1)))
        (br $rows)))))
