; LectorBit installer guidance. Keep silent deployment truly silent.
!macro NSIS_HOOK_PREINSTALL
  IfSilent lectorbit_preinstall_done
  MessageBox MB_OK|MB_ICONINFORMATION "Before LectorBit installs:$\r$\n$\r$\n1. Close any running LectorBit window.$\r$\n2. Keep about 1 GB of free disk space.$\r$\n3. Keep internet available if Microsoft Edge WebView2 is missing.$\r$\n4. Your media and study history remain local.$\r$\n$\r$\nইনস্টলের আগে LectorBit বন্ধ করুন এবং প্রায় 1 GB খালি জায়গা রাখুন।"
  lectorbit_preinstall_done:
!macroend
