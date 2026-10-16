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

correlate a b c
matrix C = r(C)
file write results "correlate,,N," %24.17g (r(N)) _n
file write results "correlate,b_a,rho," %24.17g (C[2, 1]) _n
file write results "correlate,c_a,rho," %24.17g (C[3, 1]) _n
file write results "correlate,c_b,rho," %24.17g (C[3, 2]) _n

correlate a c, covariance
matrix V = r(C)
file write results "correlate_cov,,N," %24.17g (r(N)) _n
file write results "correlate_cov,a_a,cov," %24.17g (V[1, 1]) _n
file write results "correlate_cov,c_a,cov," %24.17g (V[2, 1]) _n
file write results "correlate_cov,c_c,cov," %24.17g (V[2, 2]) _n

* distinct is Nicholas J. Cox's SSC command (ssc install distinct); it
* reports r() only for the last variable, so run it once per variable.
foreach var in a b c {
    distinct `var'
    file write results "distinct,`var',total," %24.17g (r(N)) _n
    file write results "distinct,`var',ndistinct," %24.17g (r(ndistinct)) _n

    distinct `var', missing
    file write results "distinct_missing,`var',total," %24.17g (r(N)) _n
    file write results "distinct_missing,`var',ndistinct," %24.17g (r(ndistinct)) _n
}

distinct a if c > 2
file write results "distinct_if,a,total," %24.17g (r(N)) _n
file write results "distinct_if,a,ndistinct," %24.17g (r(ndistinct)) _n

distinct a c, joint
file write results "distinct_joint,a_c,total," %24.17g (r(N)) _n
file write results "distinct_joint,a_c,ndistinct," %24.17g (r(ndistinct)) _n

distinct a c, joint missing
file write results "distinct_joint_missing,a_c,total," %24.17g (r(N)) _n
file write results "distinct_joint_missing,a_c,ndistinct," %24.17g (r(ndistinct)) _n

* duplicates report displays its panel but does not return it in r(), so
* rebuild the panel from duplicates tag (copies = tag + 1) after showing
* the real output in the log for eyeball comparison.
duplicates report
duplicates tag, gen(dupall)
levelsof dupall, local(levels)
foreach l of local levels {
    count if dupall == `l'
    file write results "duplicates_all,copies_`=`l' + 1'," %24.17g (r(N)) _n
}
drop dupall

duplicates report c
duplicates tag c, gen(dupc)
levelsof dupc, local(levels)
foreach l of local levels {
    count if dupc == `l'
    file write results "duplicates_c,copies_`=`l' + 1'," %24.17g (r(N)) _n
}
drop dupc

duplicates report c if c >= 3
duplicates tag c if c >= 3, gen(dupcif)
levelsof dupcif, local(levels)
foreach l of local levels {
    count if dupcif == `l'
    file write results "duplicates_c_if,copies_`=`l' + 1'," %24.17g (r(N)) _n
}
drop dupcif

count
file write results "count,,N," %24.17g (r(N)) _n

count if c > 2
file write results "count_if,,N," %24.17g (r(N)) _n

* by prefix. The by-prefixed commands run for the log (group order, the
* "-> c = 3" headers, and groups that the if clause empties still being
* shown); r() after by holds only the last group, so the per-group values
* are captured by looping over the groups. Kept last: bysort re-sorts.
bysort c: summarize a
bysort c: summarize a if a >= 3
bysort c: summarize a, detail
bysort c: tabulate a, missing
bysort c: count if b < 5
bysort c: distinct a, missing
bysort c: distinct a b, joint
bysort a: count

levelsof c, local(groups)
foreach g of local groups {
    summarize a if c == `g'
    file write results "by_summarize,c_`g',N,"    %24.17g (r(N))    _n
    file write results "by_summarize,c_`g',mean," %24.17g (r(mean)) _n
    file write results "by_summarize,c_`g',sd,"   %24.17g (r(sd))   _n
    file write results "by_summarize,c_`g',min,"  %24.17g (r(min))  _n
    file write results "by_summarize,c_`g',max,"  %24.17g (r(max))  _n

    summarize a if c == `g' & a >= 3
    file write results "by_summarize_if,c_`g',N," %24.17g (r(N)) _n

    summarize a if c == `g', detail
    file write results "by_summarize_detail,c_`g',N,"   %24.17g (r(N))   _n
    file write results "by_summarize_detail,c_`g',p25," %24.17g (r(p25)) _n
    file write results "by_summarize_detail,c_`g',p50," %24.17g (r(p50)) _n
    file write results "by_summarize_detail,c_`g',p75," %24.17g (r(p75)) _n

    count if c == `g' & b < 5
    file write results "by_count_if,c_`g',N," %24.17g (r(N)) _n

    distinct a if c == `g', missing
    file write results "by_distinct_missing,c_`g',total,"     %24.17g (r(N))         _n
    file write results "by_distinct_missing,c_`g',ndistinct," %24.17g (r(ndistinct)) _n

    distinct a b if c == `g', joint
    file write results "by_distinct_joint,c_`g',total,"     %24.17g (r(N))         _n
    file write results "by_distinct_joint,c_`g',ndistinct," %24.17g (r(ndistinct)) _n

    tabulate a if c == `g', missing matcell(frequencies) matrow(values)
    forvalues i = 1/`=r(r)' {
        file write results "by_tabulate_missing,c_`g',value_" ///
            %9.0g (values[`i', 1]) "," %24.17g (frequencies[`i', 1]) _n
    }
}

file close results
log close
