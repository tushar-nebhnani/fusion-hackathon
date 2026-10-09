// City and state from a PIN code, for the classifier prompt. The first two
// digits of a PIN are its postal circle, which gives the state; the first
// three are a sorting district, which gives the city for the large ones
// listed here. Coarse on purpose: the classifier only needs the region.

export interface Place {
  city: string | null;
  state: string | null;
}

// [first prefix, last prefix, state]
const STATES: readonly (readonly [number, number, string])[] = [
  [11, 11, "Delhi"],
  [12, 13, "Haryana"],
  [14, 15, "Punjab"],
  [16, 16, "Chandigarh"],
  [17, 17, "Himachal Pradesh"],
  [18, 19, "Jammu and Kashmir"],
  [20, 28, "Uttar Pradesh / Uttarakhand"],
  [30, 34, "Rajasthan"],
  [36, 39, "Gujarat"],
  [40, 44, "Maharashtra"],
  [45, 48, "Madhya Pradesh"],
  [49, 49, "Chhattisgarh"],
  [50, 50, "Telangana"],
  [51, 53, "Andhra Pradesh"],
  [56, 59, "Karnataka"],
  [60, 66, "Tamil Nadu"],
  [67, 69, "Kerala"],
  [70, 74, "West Bengal"],
  [75, 77, "Odisha"],
  [78, 78, "Assam"],
  [79, 79, "North East India"],
  [80, 85, "Bihar / Jharkhand"],
];

// Sorting districts that belong to another state than their circle
const STATE_EXCEPTIONS: Record<string, string> = {
  "403": "Goa",
  "605": "Puducherry",
  "737": "Sikkim",
  "744": "Andaman and Nicobar Islands",
};

const CITIES: Record<string, string> = {
  "110": "Delhi",
  "122": "Gurugram",
  "160": "Chandigarh",
  "201": "Ghaziabad / Noida",
  "226": "Lucknow",
  "302": "Jaipur",
  "380": "Ahmedabad",
  "395": "Surat",
  "400": "Mumbai",
  "411": "Pune",
  "440": "Nagpur",
  "462": "Bhopal",
  "500": "Hyderabad",
  "560": "Bengaluru",
  "600": "Chennai",
  "682": "Kochi",
  "700": "Kolkata",
  "751": "Bhubaneswar",
  "781": "Guwahati",
  "800": "Patna",
};

export function placeFromPincode(pincode: string | null | undefined): Place {
  if (!pincode || !/^\d{6}$/.test(pincode)) return { city: null, state: null };
  const district = pincode.slice(0, 3);
  const circle = Number(pincode.slice(0, 2));
  const state =
    STATE_EXCEPTIONS[district] ??
    STATES.find(([first, last]) => circle >= first && circle <= last)?.[2] ??
    null;
  return { city: CITIES[district] ?? null, state };
}
