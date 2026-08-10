# Die zwei Mails, die die Familie zu sehen bekommt

Supabase liefert englische Vorlagen aus („Confirm your email address — finish
signing up"). Für elf Verwandte, von denen die Hälfte nicht weiß, was ein
Account ist, ist das die falsche Sprache und das falsche Wort: niemand meldet
sich hier *an*, alle sind schon eingeladen.

Einzufügen unter **Authentication → Emails → Templates**:

| Vorlage | Datei | Wann sie kommt |
|---|---|---|
| Confirm signup | `confirm-signup.html` | beim allerersten Link |
| Magic Link | `magic-link.html` | bei jedem weiteren |

Beide brauchen dieselbe Betreffzeile: **Dein Link für Evas Treff**

`{{ .ConfirmationURL }}` ist die einzige Variable, die hier vorkommt — sie baut
Supabase selbst zusammen.
