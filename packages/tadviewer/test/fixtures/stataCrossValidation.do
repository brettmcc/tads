/*
Cross-validation fixture for Tads' Stata-style commands.

Input:  TADS_STATA_OUT environment variable naming an existing output folder.
Output: stataCrossValidation.log with Stata's displayed output and
        stataCrossValidation.csv with machine-readable returned results.
*/

version 19.0
clear all
set more off

local outdir : environment TADS_STATA_OUT
if `"`outdir'"' == "" {
    display as error "TADS_STATA_OUT is not set"
    exit 198
}

log using `"`outdir'/stataCrossValidation.log"', text replace

input double(a b) int c
1 1.5 1
2 2.5 2
3 .   3
4 4.5 3
. 5.5 5
6 6.5 5
end

file open results using `"`outdir'/stataCrossValidation.csv"', write text replace
file write results "command,variable,stat,value" _n

summarize a
file write results "summarize,a,N,"          %24.17g (r(N))    _n
file write results "summarize,a,mean,"       %24.17g (r(mean)) _n
file write results "summarize,a,sd,"         %24.17g (r(sd))   _n
file write results "summarize,a,min,"        %24.17g (r(min))  _n
file write results "summarize,a,max,"        %24.17g (r(max))  _n

summarize a, detail
file write results "summarize_detail,a,N,"        %24.17g (r(N))        _n
file write results "summarize_detail,a,sum,"      %24.17g (r(sum))      _n
file write results "summarize_detail,a,mean,"     %24.17g (r(mean))     _n
file write results "summarize_detail,a,sd,"       %24.17g (r(sd))       _n
file write results "summarize_detail,a,variance," %24.17g (r(Var))      _n
file write results "summarize_detail,a,skewness," %24.17g (r(skewness)) _n
file write results "summarize_detail,a,kurtosis," %24.17g (r(kurtosis)) _n
file write results "summarize_detail,a,p1,"       %24.17g (r(p1))       _n
file write results "summarize_detail,a,p5,"       %24.17g (r(p5))       _n
file write results "summarize_detail,a,p10,"      %24.17g (r(p10))      _n
file write results "summarize_detail,a,p25,"      %24.17g (r(p25))      _n
file write results "summarize_detail,a,p50,"      %24.17g (r(p50))      _n
file write results "summarize_detail,a,p75,"      %24.17g (r(p75))      _n
file write results "summarize_detail,a,p90,"      %24.17g (r(p90))      _n
file write results "summarize_detail,a,p95,"      %24.17g (r(p95))      _n
file write results "summarize_detail,a,p99,"      %24.17g (r(p99))      _n

summarize a if a <= 4, detail
file write results "summarize_detail_filtered,a,N,"   %24.17g (r(N))   _n
file write results "summarize_detail_filtered,a,p25," %24.17g (r(p25)) _n
file write results "summarize_detail_filtered,a,p50," %24.17g (r(p50)) _n
file write results "summarize_detail_filtered,a,p75," %24.17g (r(p75)) _n

tabulate c, matcell(frequencies) matrow(values)
file write results "tabulate,c,N," %24.17g (r(N)) _n
forvalues i = 1/`=r(r)' {
    file write results "tabulate,c,value_" %9.0g (values[`i', 1]) "," ///
        %24.17g (frequencies[`i', 1]) _n
}

count
file write results "count,,N," %24.17g (r(N)) _n

count if c > 2
file write results "count_if,,N," %24.17g (r(N)) _n

file close results
log close
