/*
 * Where the hub lives. Both values are public by design: the key grants
 * nothing without a signed-in session, because every table and both storage
 * buckets are closed by row level security.
 */
window.SUPABASE_CONFIG = {
  url: 'https://xpkkezwrmqgwgenpqvhq.supabase.co',
  key: 'sb_publishable_AirUDX2LsKNfSgvZeH_lYA_XkxELowc',

  /*
   * Der öffentliche Teil des VAPID-Schlüsselpaars für Benachrichtigungen.
   *
   * Er gehört hierher: der Browser braucht ihn beim Anmelden, und er ist genau
   * dafür da, öffentlich zu sein — er weist nur aus, WER die Nachricht
   * schickt. Der private Teil liegt als Geheimnis bei den Edge Functions und
   * kommt nie in dieses Repository, das öffentlich ist.
   */
  vapidPublicKey: 'BMD1BMncXMZoSb8WIunkIVWzTTAdn681hlwybS-IQPRTbnwgOX9AXAEJix-SE_OqI6XeOLqpuGQiI0n8PTXj1HI'
};
