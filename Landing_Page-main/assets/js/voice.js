/* ThreatReady — voice dictation for the live demo (Web Speech API).
   Ported unchanged from the previous landing page. Expects #dVoiceBtn, #dVoiceLabel, #dVoiceStatus, #dAns. */
(function setupVoice(){
  const btn = document.getElementById('dVoiceBtn');
  const label = document.getElementById('dVoiceLabel');
  const status = document.getElementById('dVoiceStatus');
  const textarea = document.getElementById('dAns');
  if (!btn || !textarea) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SGL = window.SpeechGrammarList || window.webkitSpeechGrammarList;
  if (!SR) {
    btn.classList.add('dvoice-unsup');
    btn.setAttribute('disabled', 'true');
    label.textContent = 'Voice (browser not supported)';
    btn.title = 'Web Speech API not supported in this browser. Use Chrome, Edge, Brave or Safari.';
    return;
  }

  let recognition = null;
  let isListening = false;
  let committed = '';
  let interim = '';
  let lastResultTime = Date.now();
  let processedFinalIndices = new Set();
  let lastSessionFinalCount = 0;

  const DOMAIN_TERMS = new Set([
    'mitre','att&ck','attck','cve','cvss','iam','rbac','soc','siem','soar','xdr','edr','dlp',
    'tls','ssl','vpn','dns','tcp','udp','xss','csrf','sql','sqli','rce','ssrf','xxe','idor',
    'aws','azure','gcp','s3','ec2','iam','rds','kms','vpc','lambda','dynamodb','cognito','cloudtrail','cloudfront','guardduty',
    'kubernetes','k8s','kubectl','helm','istio','envoy','etcd','docker','containerd',
    'oauth','oidc','saml','jwt','mfa','2fa','sso','ldap','kerberos','passkey','fido2','webauthn',
    'github','gitlab','jenkins','terraform','ansible','ci','cd','devops','devsecops','sast','dast','sca',
    'crowdstrike','wiz','snyk','tenable','qualys',
    'ransomware','phishing','malware','rootkit','keylogger','botnet','c2','exfiltration',
    'gdpr','ccpa','dpdpa','hipaa','pci','pcidss','soc2','iso27001','nist','cis',
    'incident','forensic','triage','containment','remediation','playbook','runbook','tabletop',
    'log4j','log4shell','spring4shell','heartbleed','solarwinds',
    't1078','t1110','t1190','t1486','t1537','t1059','t1611','t1195'
  ]);

  const PUNCTUATION_COMMANDS = [
    [/\b(comma)\b/gi, ','],
    [/\b(period|full stop|fullstop|dot)\b/gi, '.'],
    [/\b(question mark)\b/gi, '?'],
    [/\b(exclamation mark|exclamation point)\b/gi, '!'],
    [/\b(colon)\b/gi, ':'],
    [/\b(semi colon|semicolon)\b/gi, ';'],
    [/\b(open quote|quote)\b/gi, '"'],
    [/\b(close quote|unquote)\b/gi, '"'],
    [/\b(open paren|open bracket)\b/gi, '('],
    [/\b(close paren|close bracket)\b/gi, ')'],
    [/\b(hyphen|dash)\b/gi, '-'],
    [/\b(slash)\b/gi, '/'],
    [/\b(new line|new paragraph|new para|line break)\b/gi, '\n'],
    [/\b(space)\b/gi, ' '],
  ];

  const HOMOPHONE_FIXES = [
    [/\bL\s*A\s*M\s*A\b/gi, 'Lambda'],
    [/\bLama\b/gi, 'Lambda'],
    [/\bess\s+three\b/gi, 'S3'],
    [/\bS\s+three\b/gi, 'S3'],
    [/\bI\s+am\s+role\b/gi, 'IAM role'],
    [/\bI\s+am\s+policy\b/gi, 'IAM policy'],
    [/\bI\s+am\s+user\b/gi, 'IAM user'],
    [/\bAWS\s+I\s+am\b/gi, 'AWS IAM'],
    [/\bee\s+see\s+two\b/gi, 'EC2'],
    [/\bE\s+C\s+two\b/gi, 'EC2'],
    [/\bare\s+ds\b/gi, 'RDS'],
    [/\bV\s+P\s+C\b/gi, 'VPC'],
    [/\bsee\s+V\s+E\b/gi, 'CVE'],
    [/\bC\s+V\s+E\b/gi, 'CVE'],
    [/\bmiter\b/gi, 'MITRE'],
    [/\bmight\s+her\b/gi, 'MITRE'],
    [/\bmitre\s+attack\b/gi, 'MITRE ATT&CK'],
    [/\bmitre\s+att\s+and\s+ck\b/gi, 'MITRE ATT&CK'],
    [/\battack\s+and\s+see\s+kay\b/gi, 'ATT&CK'],
    [/\bO\s+auth\b/gi, 'OAuth'],
    [/\boath\b/gi, 'OAuth'],
    [/\bO\s+I\s+D\s+C\b/gi, 'OIDC'],
    [/\bjot\b/gi, 'JWT'],
    [/\bJ\s+W\s+T\b/gi, 'JWT'],
    [/\bsam\s+l\b/gi, 'SAML'],
    [/\bM\s+F\s+A\b/gi, 'MFA'],
    [/\btwo\s+F\s+A\b/gi, '2FA'],
    [/\bS\s+S\s+O\b/gi, 'SSO'],
    [/\bS\s+Q\s+L\b/gi, 'SQL'],
    [/\bsequel\s+injection\b/gi, 'SQL injection'],
    [/\bX\s+S\s+S\b/gi, 'XSS'],
    [/\bC\s+S\s+R\s+F\b/gi, 'CSRF'],
    [/\bsea\s+surf\b/gi, 'CSRF'],
    [/\bR\s+C\s+E\b/gi, 'RCE'],
    [/\bS\s+S\s+R\s+F\b/gi, 'SSRF'],
    [/\bcube\s+control\b/gi, 'kubectl'],
    [/\bkube\s+ctl\b/gi, 'kubectl'],
    [/\bK\s+eight\s+S\b/gi, 'k8s'],
    [/\bkay\s+8\s+s\b/gi, 'k8s'],
    [/\bcube\s+net\s+es\b/gi, 'Kubernetes'],
    [/\btiara\s+form\b/gi, 'Terraform'],
    [/\bterror\s+form\b/gi, 'Terraform'],
    [/\bgit\s+hub\b/gi, 'GitHub'],
    [/\bgit\s+lab\b/gi, 'GitLab'],
    [/\bdev\s+sec\s+ops\b/gi, 'DevSecOps'],
    [/\bdev\s+ops\b/gi, 'DevOps'],
    [/\blog\s+for\s+J\b/gi, 'Log4j'],
    [/\blog\s+for\s+shell\b/gi, 'Log4Shell'],
    [/\bspring\s+for\s+shell\b/gi, 'Spring4Shell'],
    [/\bsolar\s+winds\b/gi, 'SolarWinds'],
    [/\bzero\s+trust\b/gi, 'zero trust'],
    [/\bcloud\s+trail\b/gi, 'CloudTrail'],
    [/\bguard\s+duty\b/gi, 'GuardDuty'],
    [/\bV\s+P\s+C\s+flow\b/gi, 'VPC Flow'],
  ];

  const ALWAYS_CAPS = ['MITRE','ATT&CK','AWS','GCP','EC2','S3','VPC','IAM','RDS','KMS','RBAC','SOC','SIEM','EDR','XDR','DLP','MFA','SSO','OAuth','OIDC','SAML','JWT','XSS','CSRF','SQL','RCE','SSRF','XXE','IDOR','TLS','SSL','VPN','DNS','TCP','UDP','HTTP','HTTPS','API','CVE','CVSS','GDPR','HIPAA','PCI','NIST','CIS','ISO','DPDPA','CERT-In','DevSecOps','DevOps','GitHub','GitLab','CloudTrail','GuardDuty','Kubernetes','Terraform','Lambda','DynamoDB','Cognito','CloudFront','Log4j','Log4Shell','SolarWinds'];

  function applyPunctuation(text){
    let out = text;
    PUNCTUATION_COMMANDS.forEach(([re, repl]) => { out = out.replace(re, repl); });
    out = out.replace(/\s+([,.!?:;])/g, '$1');
    out = out.replace(/([,.!?:;])(?=\S)/g, '$1 ');
    out = out.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
    out = out.replace(/\n\s+/g, '\n');
    return out;
  }

  function applyDomainFixes(text){
    let out = text;
    HOMOPHONE_FIXES.forEach(([re, repl]) => { out = out.replace(re, repl); });
    ALWAYS_CAPS.forEach(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('\\b' + escaped + '\\b', 'gi');
      out = out.replace(re, term);
    });
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
    return out;
  }

  function scoreAlternative(alt){
    let score = (alt.confidence != null ? alt.confidence : 0.5);
    const tokens = alt.transcript.toLowerCase().match(/[a-z0-9&]+/g) || [];
    let domainHits = 0;
    tokens.forEach(t => { if (DOMAIN_TERMS.has(t)) domainHits++; });
    score += Math.min(0.20, domainHits * 0.02);
    if (alt.transcript.trim().length < 4) score -= 0.15;
    return score;
  }

  function bestAlternative(result){
    let best = result[0];
    let bestScore = scoreAlternative(best);
    for (let i = 1; i < result.length; i++){
      const s = scoreAlternative(result[i]);
      if (s > bestScore){ best = result[i]; bestScore = s; }
    }
    return { transcript: best.transcript, confidence: best.confidence || 0 };
  }

  function maybeInsertPause(committedText){
    const now = Date.now();
    const gap = now - lastResultTime;
    lastResultTime = now;
    if (gap > 1800 && committedText && !/[.!?,;]\s*$/.test(committedText)){
      return committedText + '. ';
    }
    return committedText.endsWith(' ') ? committedText : committedText + ' ';
  }

  function setStatus(msg, cls){
    status.textContent = msg;
    status.className = 'dvoice-status' + (cls ? ' ' + cls : '');
  }

  function render(){
    let combined = committed + (interim ? ' ' + interim : '');
    combined = applyPunctuation(combined);
    combined = applyDomainFixes(combined);
    textarea.value = combined.trim();
  }

  function start(){
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 5;
    recognition.lang = (navigator.language && /^en/i.test(navigator.language)) ? navigator.language : 'en-IN';

    if (SGL){
      try {
        const grammarTerms = Array.from(DOMAIN_TERMS).slice(0, 80).join(' | ');
        const grammar = '#JSGF V1.0; grammar securityTerms; public <term> = ' + grammarTerms + ' ;';
        const grammars = new SGL();
        grammars.addFromString(grammar, 1);
        recognition.grammars = grammars;
      } catch(e){}
    }

    committed = textarea.value.trim();
    interim = '';
    lastResultTime = Date.now();
    processedFinalIndices = new Set();
    lastSessionFinalCount = 0;

    recognition.onstart = () => {
      isListening = true;
      btn.classList.add('recording');
      btn.setAttribute('aria-pressed', 'true');
      label.textContent = 'Stop & save';
      setStatus('🎙 Listening', 'listening');
    };

    recognition.onresult = (e) => {
      let newInterim = '';
      // Mobile Chrome bug: each new final result is the CUMULATIVE transcript,
      // not just new words. We track the last appended final string and only
      // append the delta (new content beyond what we already have).
      for (let i = 0; i < e.results.length; i++){
        const result = e.results[i];
        const best = bestAlternative(result);
        if (result.isFinal){
          if (processedFinalIndices.has(i)) continue;
          processedFinalIndices.add(i);
          const phrase = best.transcript.trim();
          if (!phrase) continue;
          
          // Check if this phrase is an extension of something we already committed.
          // Compare normalized text (lowercase, no punctuation).
          const committedNorm = committed.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          const phraseNorm = phrase.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
          
          let toAppend = phrase;
          
          // Case 1: phrase is identical to or already contained in committed → skip
          if (committedNorm.endsWith(phraseNorm)) continue;
          
          // Case 2: phrase EXTENDS committed (committed ends with the start of phrase)
          // Find the longest suffix of committed that's a prefix of phrase
          if (committedNorm.length > 0) {
            const committedWords = committedNorm.split(' ');
            const phraseWords = phraseNorm.split(' ');
            let overlapWords = 0;
            // Try matching the last N words of committed to first N words of phrase
            for (let n = Math.min(committedWords.length, phraseWords.length); n > 0; n--) {
              const committedTail = committedWords.slice(-n).join(' ');
              const phraseHead = phraseWords.slice(0, n).join(' ');
              if (committedTail === phraseHead) {
                overlapWords = n;
                break;
              }
            }
            if (overlapWords > 0) {
              // Strip the overlapping prefix from the original (non-normalized) phrase
              const originalWords = phrase.split(/\s+/);
              toAppend = originalWords.slice(overlapWords).join(' ').trim();
              if (!toAppend) continue;  // entire phrase was overlap
            }
          }
          
          committed = (maybeInsertPause(committed) + toAppend).replace(/\s+/g, ' ').trim();
        } else {
          if (i >= e.resultIndex) {
            newInterim += best.transcript;
          }
        }
      }
      interim = newInterim.trim();
      render();
    };

    recognition.onerror = (e) => {
      let msg;
      switch (e.error){
        case 'not-allowed':
        case 'service-not-allowed':
          msg = 'Microphone access denied. Allow mic permission in your browser and try again.'; break;
        case 'no-speech':
          msg = 'No speech detected. Try speaking again.'; break;
        case 'audio-capture':
          msg = 'No microphone found on this device.'; break;
        case 'network':
          msg = 'Network error. Speech recognition needs an internet connection.'; break;
        case 'aborted':
          msg = ''; break;
        default:
          msg = 'Speech error (' + e.error + '). Try again.';
      }
      if (msg) setStatus(msg, 'error');
      stop(true);
    };

    recognition.onend = () => {
      if (isListening && !document.hidden){
        // On auto-restart, mobile Chrome resets the results array to index 0.
        // Clear our processed-indices set so the new session's indices aren't
        // confused with the old session's.
        processedFinalIndices = new Set();
        try { recognition.start(); }
        catch(err){ stop(true); }
      } else if (isListening){
        stop(true);
      }
    };

    try {
      recognition.start();
    } catch(err){
      setStatus('Could not start voice input.', 'error');
      stop(true);
    }
  }

  function stop(silent){
    isListening = false;
    btn.classList.remove('recording');
    btn.setAttribute('aria-pressed', 'false');
    label.textContent = 'Voice answer';
    if (recognition){
      try { recognition.stop(); } catch(e){}
      recognition = null;
    }
    if (interim){
      committed = (committed + ' ' + interim).trim();
      interim = '';
      render();
    }
    if (!silent){
      let finalText = applyPunctuation(committed);
      finalText = applyDomainFixes(finalText);
      textarea.value = finalText.trim();
      setStatus('Saved. Review and edit before submitting.');
    }
  }


  btn.addEventListener('click', () => {
    if (isListening) stop(false);
    else start();
  });

  textarea.addEventListener('keydown', () => {
    if (isListening){
      setTimeout(() => { if (isListening) stop(true); }, 200);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isListening){
      stop(false);
      setStatus('🛑 Voice stopped — you switched tabs or windows.');
    }
  });
  window.addEventListener('blur', () => {
    if (isListening){
      stop(false);
      setStatus('🛑 Voice stopped — focus left the page.');
    }
  });
  window.addEventListener('pagehide', () => { if (isListening) stop(true); });
})();
