use std::cmp::Ordering;

/// Compare human-facing labels while treating ASCII digit runs numerically.
/// This keeps course names such as `2 - Intro` before `10 - Advanced`.
pub fn natural_cmp(left: &str, right: &str) -> Ordering {
    let mut left = left.chars().peekable();
    let mut right = right.chars().peekable();

    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let a_digits = take_digits(&mut left);
                let b_digits = take_digits(&mut right);
                let a_significant = a_digits.trim_start_matches('0');
                let b_significant = b_digits.trim_start_matches('0');
                let a_significant = if a_significant.is_empty() {
                    "0"
                } else {
                    a_significant
                };
                let b_significant = if b_significant.is_empty() {
                    "0"
                } else {
                    b_significant
                };
                let ordering = a_significant
                    .len()
                    .cmp(&b_significant.len())
                    .then_with(|| a_significant.cmp(b_significant))
                    .then_with(|| a_digits.len().cmp(&b_digits.len()));
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (Some(a), Some(b)) => {
                left.next();
                right.next();
                let ordering = a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

fn take_digits(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while iter.peek().is_some_and(char::is_ascii_digit) {
        digits.push(iter.next().expect("peeked digit"));
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_prefixes_sort_by_value() {
        let mut labels = vec![
            "10 - Feature Scaling.mp4",
            "2 - Machine Learning Demo Get Excited.mp4",
            "1 - Welcome.mp4",
        ];
        labels.sort_by(|left, right| natural_cmp(left, right));
        assert_eq!(
            labels,
            vec![
                "1 - Welcome.mp4",
                "2 - Machine Learning Demo Get Excited.mp4",
                "10 - Feature Scaling.mp4",
            ]
        );
    }

    #[test]
    fn very_large_numbers_do_not_overflow() {
        assert_eq!(
            natural_cmp("999999999999999999999 lesson", "10 lesson"),
            Ordering::Greater
        );
    }
}
