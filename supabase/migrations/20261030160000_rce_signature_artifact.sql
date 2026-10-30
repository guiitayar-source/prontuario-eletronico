-- A RCE guarda a resposta CMS do provedor (signature.json) antes de embutir no PDF, para
-- recuperar sem assinar de novo. O bucket só aceitava imagem e PDF, e a gravação falhava
-- depois da assinatura remota (a emissão ia para SIGNATURE_UNCERTAIN).
update storage.buckets
   set allowed_mime_types = array_append(allowed_mime_types, 'application/json')
 where id = 'clinical-files'
   and not ('application/json' = any(allowed_mime_types));
