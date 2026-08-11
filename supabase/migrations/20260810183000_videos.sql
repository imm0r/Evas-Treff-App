-- Videos neben den Fotos.
--
-- Keine eigene Tabelle: ein Video hängt an einem Album, hat einen Hochlader,
-- eine Aufnahmezeit und Kommentare — das ist Zeile für Zeile dieselbe Zeile.
-- Eine zweite Tabelle hieße, jede Abfrage der Galerie zu verdoppeln und beim
-- Sortieren wieder zusammenzuführen.
alter table public.photos
  add column media_type text not null default 'image'
    check (media_type in ('image', 'video')),
  -- Sekunden mit einer Nachkommastelle: die Anzeige rundet ohnehin, aber
  -- 0.4 s soll nicht zu 0 werden und dann wie "keine Angabe" aussehen.
  add column duration_seconds numeric(6, 1)
    check (duration_seconds is null or duration_seconds > 0);

-- Eine Dauer ergibt nur bei Videos einen Sinn, und ein Video ohne Dauer ist
-- eins, das beim Hochladen nicht gelesen werden konnte — beides soll die
-- Tabelle sagen können, ohne dass die Oberfläche raten muss.
alter table public.photos
  add constraint photos_duration_only_for_video
    check (media_type = 'video' or duration_seconds is null);

comment on column public.photos.media_type is
  'image oder video. Der Rest der Zeile bedeutet für beide dasselbe: '
  'storage_path ist die Datei, thumb_path das Vorschaubild — bei einem Video '
  'ein Standbild, das der Browser des Hochladers herausgezogen hat.';

-- Der Eimer nimmt bisher nur JPEG an, und das war Absicht: alles ging durch
-- die Verkleinerung. Videos gehen unverändert durch, also muss hier stehen,
-- was erlaubt ist.
--
-- quicktime ist .mov vom iPhone. Es wird angenommen, OBWOHL es nicht jeder
-- Browser abspielen kann — abweisen hieße, dass die halbe Familie gar nicht
-- erst hochladen kann. Stattdessen zieht die App vorher ein Standbild und
-- zeigt beim Abspielen einen ehrlichen Hinweis samt Download, wenn es beim
-- Betrachter nicht geht.
update storage.buckets
set allowed_mime_types = array[
      'image/jpeg',
      'video/mp4',
      'video/quicktime',
      'video/webm'
    ],
    -- 200 MB. Der Upload läuft in EINEM Rutsch ohne Wiederaufsetzen, also ist
    -- das nicht die Grenze des Plans, sondern die Grenze dessen, was auf einer
    -- wackligen Mobilverbindung noch ankommt.
    file_size_limit = 209715200
where id = 'photos';
