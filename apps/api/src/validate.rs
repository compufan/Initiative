//! Small validation helpers mirroring the client-side schemas.

use crate::constants::*;
use crate::error::{AppError, AppResult};

pub struct Validator {
    issues: Vec<(&'static str, String)>,
}

impl Validator {
    pub fn new() -> Self {
        Self { issues: Vec::new() }
    }

    pub fn require(&mut self, field: &'static str, condition: bool, message: &str) -> &mut Self {
        if !condition {
            self.issues.push((field, message.to_string()));
        }
        self
    }

    pub fn length(
        &mut self,
        field: &'static str,
        value: &str,
        min: usize,
        max: usize,
    ) -> &mut Self {
        let length = value.chars().count();
        if length < min {
            self.issues.push((field, format!("mindestens {min} Zeichen")));
        } else if length > max {
            self.issues.push((field, format!("höchstens {max} Zeichen")));
        }
        self
    }

    pub fn one_of(&mut self, field: &'static str, value: &str, allowed: &[&str]) -> &mut Self {
        if !allowed.contains(&value) {
            self.issues
                .push((field, format!("erlaubt sind: {}", allowed.join(", "))));
        }
        self
    }

    pub fn finish(&mut self) -> AppResult<()> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(AppError::validation(std::mem::take(&mut self.issues)))
        }
    }
}

impl Default for Validator {
    fn default() -> Self {
        Self::new()
    }
}

/// Usernames are lowercase and limited to letters, digits, dot and underscore.
pub fn normalise_username(value: &str) -> AppResult<String> {
    let trimmed = value.trim().to_lowercase();
    let length = trimmed.chars().count();
    if length < USERNAME_MIN || length > USERNAME_MAX {
        return Err(AppError::validation(vec![(
            "username",
            format!("zwischen {USERNAME_MIN} und {USERNAME_MAX} Zeichen"),
        )]));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return Err(AppError::validation(vec![(
            "username",
            "nur Buchstaben, Ziffern, Punkt und Unterstrich".to_string(),
        )]));
    }
    Ok(trimmed)
}

pub fn check_password(value: &str) -> AppResult<()> {
    let length = value.chars().count();
    if length < PASSWORD_MIN || length > PASSWORD_MAX {
        return Err(AppError::validation(vec![(
            "password",
            format!("zwischen {PASSWORD_MIN} und {PASSWORD_MAX} Zeichen"),
        )]));
    }
    Ok(())
}

/// Trims and turns an empty string into `None`.
pub fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
