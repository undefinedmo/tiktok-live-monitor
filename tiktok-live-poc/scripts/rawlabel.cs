// rawlabel.exe — send raw bytes (ZPL/EPL/TSPL) straight to a Windows printer via the
// spooler RAW datatype. Bypasses the driver + any app render. Reads the payload from
// stdin; prints "OK <n>" or "ERR <msg>" to stdout. `--dryrun` opens/closes the printer
// only (no print job) so startup+winspool overhead can be measured without wasting stock.
// Build: csc /nologo /optimize /target:exe /out:rawlabel.exe rawlabel.cs
using System;
using System.IO;
using System.Runtime.InteropServices;

class RawLabel {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  class DOCINFO { public string pDocName; public string pOutputFile; public string pDatatype; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool StartDocPrinter(IntPtr h, int level, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);

  static int Main(string[] args) {
    if (args.Length < 1) { Console.Error.WriteLine("usage: rawlabel <printerName> [--dryrun]"); return 2; }
    string printer = args[0];
    bool dry = args.Length > 1 && args[1] == "--dryrun";
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) { Console.Out.WriteLine("ERR OpenPrinter " + Marshal.GetLastWin32Error()); return 1; }
    try {
      if (dry) { Console.Out.WriteLine("DRYRUN OK"); return 0; }
      byte[] data;
      using (var stdin = Console.OpenStandardInput())
      using (var ms = new MemoryStream()) { stdin.CopyTo(ms); data = ms.ToArray(); }
      var di = new DOCINFO { pDocName = "Label", pDatatype = "RAW" };
      if (!StartDocPrinter(h, 1, di)) { Console.Out.WriteLine("ERR StartDoc " + Marshal.GetLastWin32Error()); return 1; }
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, data, data.Length, out written);
      EndPagePrinter(h); EndDocPrinter(h);
      Console.Out.WriteLine(ok ? ("OK " + written) : ("ERR WritePrinter " + Marshal.GetLastWin32Error()));
      return ok ? 0 : 1;
    } finally { ClosePrinter(h); }
  }
}
