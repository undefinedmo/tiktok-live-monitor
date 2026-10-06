// rawlabel.exe — send raw bytes (ZPL/EPL/TSPL) straight to a Windows printer via the
// spooler RAW datatype. Bypasses the driver + any app render. Reads the payload from
// stdin. `--dryrun` opens/closes the printer only (no print job) so startup+winspool
// overhead can be measured without wasting stock.
//
// Build: csc /nologo /optimize /target:exe /out:rawlabel.exe rawlabel.cs
//
// ── Output contract ────────────────────────────────────────────────────────────────
// One line on stdout: "<STATUS> <detail>", plus "status=0x<hex>" when the printer's own
// state word was readable. The caller keys on STATUS, never on the exit code alone:
//
//   OK <bytes>       the job was written AND committed to the spooler
//   OPEN_FAILED <e>  OpenPrinter failed — nothing was sent, no job exists
//   START_FAILED <e> StartDocPrinter failed — nothing was sent, no job exists
//   WRITE_FAILED <e> WritePrinter failed mid-job — a job may exist, treat as committed
//
// Why the distinction matters: the caller falls back to a slow HTML render when raw
// printing fails, and falling back after the bytes already reached the spooler prints the
// label TWICE. Only OPEN_FAILED and START_FAILED are safe to retry — they are the states
// where the spooler provably has nothing. That was a live double-print waiting to happen:
// the caller's 8s timeout could fire after StartDoc/Write had already committed the job.
//
// status=0x… is GetPrinter level-2's Status word (PRINTER_STATUS_*). "The spooler accepted
// the bytes" is NOT "the label came out" — a paused/offline/paper-out printer accepts jobs
// silently and flushes them later in a burst. Reporting the state here is what lets the
// app's watchdog say "printer paused, 12 labels queued" instead of showing nothing wrong.
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
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetPrinter(IntPtr h, int level, IntPtr buf, int cb, out int needed);

  // PRINTER_INFO_2's Status and cJobs sit at fixed offsets past a run of pointers. Rather
  // than mirror the whole struct (18 fields, pointer-size dependent), walk to them: 13
  // pointers, then 5 DWORDs, then Status, then cJobs. Verified against the documented
  // layout for both 32- and 64-bit.
  static bool ReadPrinterState(IntPtr h, out uint status, out uint jobs) {
    status = 0; jobs = 0;
    int needed;
    GetPrinter(h, 2, IntPtr.Zero, 0, out needed); // sizing call: expected to fail
    if (needed <= 0) return false;
    IntPtr buf = Marshal.AllocHGlobal(needed);
    try {
      if (!GetPrinter(h, 2, buf, needed, out needed)) return false;
      int ps = IntPtr.Size;
      int off = ps * 13 + 4 * 5; // 13 pointer fields, then Attributes/Priority/Default/StartTime/UntilTime
      status = (uint)Marshal.ReadInt32(buf, off);
      jobs = (uint)Marshal.ReadInt32(buf, off + 4);
      return true;
    } catch {
      return false;
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }

  static string StateSuffix(IntPtr h) {
    uint status, jobs;
    if (!ReadPrinterState(h, out status, out jobs)) return "";
    return " status=0x" + status.ToString("X") + " jobs=" + jobs;
  }

  static int Main(string[] args) {
    if (args.Length < 1) { Console.Error.WriteLine("usage: rawlabel <printerName> [--dryrun]"); return 2; }
    string printer = args[0];
    bool dry = args.Length > 1 && args[1] == "--dryrun";
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) {
      // Nothing opened, nothing sent — the caller may safely fall back.
      Console.Out.WriteLine("OPEN_FAILED " + Marshal.GetLastWin32Error());
      return 1;
    }
    try {
      if (dry) { Console.Out.WriteLine("OK dryrun" + StateSuffix(h)); return 0; }
      byte[] data;
      using (var stdin = Console.OpenStandardInput())
      using (var ms = new MemoryStream()) { stdin.CopyTo(ms); data = ms.ToArray(); }
      var di = new DOCINFO { pDocName = "Label", pDatatype = "RAW" };
      if (!StartDocPrinter(h, 1, di)) {
        // The document never started; the spooler has no job. Safe to fall back.
        Console.Out.WriteLine("START_FAILED " + Marshal.GetLastWin32Error() + StateSuffix(h));
        return 1;
      }
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, data, data.Length, out written);
      int err = ok ? 0 : Marshal.GetLastWin32Error();
      EndPagePrinter(h); EndDocPrinter(h);
      // Past StartDoc a job EXISTS even if the write failed part-way. Never report this as
      // a clean failure — a fallback here is the double-print.
      Console.Out.WriteLine((ok ? "OK " + written : "WRITE_FAILED " + err) + StateSuffix(h));
      return ok ? 0 : 1;
    } finally { ClosePrinter(h); }
  }
}
