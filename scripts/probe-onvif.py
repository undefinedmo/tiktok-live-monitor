import base64, hashlib, secrets, datetime, urllib.request, urllib.error, re

USER, PASS, HOST = 'admin', 'admin', '10.0.0.61'

def wsse():
    nonce = secrets.token_bytes(16)
    created = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + PASS.encode()).digest()).decode()
    return f'''<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
<wsse:UsernameToken><wsse:Username>{USER}</wsse:Username>
<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest}</wsse:Password>
<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{base64.b64encode(nonce).decode()}</wsse:Nonce>
<wsu:Created>{created}</wsu:Created></wsse:UsernameToken></wsse:Security>'''

def soap(endpoint, body):
    env = f'''<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
<s:Header>{wsse()}</s:Header>
<s:Body>{body}</s:Body></s:Envelope>'''
    req = urllib.request.Request(endpoint, data=env.encode(),
        headers={'Content-Type': 'application/soap+xml; charset=utf-8'})
    try:
        return urllib.request.urlopen(req, timeout=6).read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return f'HTTP {e.code}: {e.read().decode("utf-8","replace")[:200]}'

DEV = f'http://{HOST}/onvif/device_service'
print('=== GetCapabilities (does this camera advertise PTZ?) ===')
xml = soap(DEV, '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>')
for service in ('Analytics','Device','Events','Imaging','Media','PTZ','Extension'):
    m = re.search(rf'<(?:\w+:)?{service}\b[^>]*>(.*?)</(?:\w+:)?{service}>', xml, re.S)
    if m:
        xaddr = re.search(r'<(?:\w+:)?XAddr>([^<]+)</(?:\w+:)?XAddr>', m.group(1))
        print(f'  {service}: XAddr={xaddr.group(1) if xaddr else "(present, no XAddr)"}')
    else:
        print(f'  {service}: NOT ADVERTISED')

print()
print('=== Imaging: zoom/focus options (per video source) ===')
# Need a VideoSource token. Use GetVideoSources from media.
xml = soap(DEV, '<GetVideoSources xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
vs_tokens = re.findall(r'<(?:\w+:)?VideoSources[^>]*token="([^"]+)"', xml)
print(f'  VideoSource tokens: {vs_tokens}')
for tok in vs_tokens:
    body = f'<GetMoveOptions xmlns="http://www.onvif.org/ver20/imaging/wsdl"><VideoSourceToken>{tok}</VideoSourceToken></GetMoveOptions>'
    r = soap(DEV, body)
    print(f'  GetMoveOptions({tok}):')
    # Look for Continuous / Absolute / Relative ranges for zoom/focus
    for label in ('Continuous','Absolute','Relative'):
        if f'<{label}' in r or f':{label}' in r:
            snippet = re.search(rf'<(?:\w+:)?{label}[^>]*>(.*?)</(?:\w+:)?{label}>', r, re.S)
            if snippet:
                print(f'    {label}: {snippet.group(1).strip()[:300]}')
    if 'Fault' in r or 'HTTP 4' in r:
        print(f'    (fault) {r[:200]}')

    # Also try GetOptions for the imaging settings (focus mode, etc.)
    body2 = f'<GetOptions xmlns="http://www.onvif.org/ver20/imaging/wsdl"><VideoSourceToken>{tok}</VideoSourceToken></GetOptions>'
    r2 = soap(DEV, body2)
    focus = re.search(r'<(?:\w+:)?Focus[^>]*>(.*?)</(?:\w+:)?Focus>', r2, re.S)
    if focus:
        print(f'    Imaging Focus options: {focus.group(1).strip()[:300]}')
