---
name: met-museum-guide
description: Gates for the met_* tools, the Metropolitan Museum of Art collection. Budgeting met_get_object fetches under the Met firewall, reading the attributions matchField artistOrCulture returns, padding date windows, splitting a search past its 10,000-match window, and reading geoLocation matches. Use before counting, comparing, or listing Met holdings, attributing works to an artist or culture, or filtering by date or place.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Object records and the CC0 images of public-domain works from The Metropolitan Museum of Art's keyless Collection API. It has no artist or constituent lookup (no tool takes a constituentID), no exhibition data, and no list of the values medium or geoLocation accept.

## Gates

### Fetch only the records the answer needs

- A search or list total, with its object IDs, answers how many and which. Fetch records only when the answer turns on a per-record field (CC0 status, attribution, exact dates), and say whether each figure counts every match or only the records you read.
- One met_get_object call fetches up to 20 records, so a full 500-ID page is 25 calls and 500 Met requests. Before starting one, narrow the search or fetch a sample, and tell the user which you did.
- The one-call-at-a-time rule in the server instructions covers searches too: a breakdown by department is 19 searches, sent one after another.

### Read the attribution before naming a maker

- A matchField artistOrCulture result is not a list of one person's own works. It includes qualified attributions (437403, "Style of" Rembrandt, for q "Rembrandt") and works matched through their culture alone (240180, with no artist and culture "Greek, Attic", for q "Attic"). Before counting a result as someone's work, read artistPrefix and artistRole on each record, and report a prefix with the name.
- It leaves out works where the person is only another constituent (742412, with Rembrandt as sitter; 770799, "After Rembrandt"). For works after, about, or depicting a person, search without matchField and read constituents on the records.

### Pad date windows, then select by overlap

- For works from a period, search a window padded at least ten years past each end, since the date filter drops any span that crosses a bound: 54305, "ca. 1832", is stored as 1822 to 1842. Then fetch the records and keep those whose objectBeginDate to objectEndDate overlaps the period. Give dates from objectDate, not from the stored bounds.
- A window that spans year 0 also brings in undated records. Drop them or say they are undated.

### Split a search past 10,000 matches

- To reach every match of a search over 10,000, split it into parts that each total under 10,000, by departmentId or by hasImages true and false, and check that the parts' totals add up to the whole before calling the walk complete.
- Departments 7 (The Cloisters) and 17 (Medieval Art) each report the combined total of both. Count that total once.
- Never split by adjacent date windows. An object whose span crosses the boundary lands in neither window, and undated records land only in a window that spans year 0.

### Take a geoLocation match from the filter

- Cite the filter as the evidence for a record's place, and never re-filter fetched records by country, region, or city to confirm a match: 240180 matches "Greece" with every place field empty.
