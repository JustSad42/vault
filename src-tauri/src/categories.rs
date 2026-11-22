//! Automatic categories: from the item type, then the website's domain, then words in the title or address.
use crate::{domain, vault::Item};

pub const ALL: &[&str] = &["Email", "Social", "Finance", "Shopping", "Developer", "Gaming", "Entertainment", "Work", "Cloud", "Travel", "Education", "News", "Health", "Government", "Identity", "Network", "Notes", "Other"];

const DOMAINS: &[(&str, &str)] = &[
    ("gmail.com", "Email"), ("outlook.com", "Email"), ("live.com", "Email"), ("proton.me", "Email"), ("protonmail.com", "Email"), ("yahoo.com", "Email"), ("icloud.com", "Email"), ("fastmail.com", "Email"), ("zoho.com", "Email"), ("mail.com", "Email"),
    ("facebook.com", "Social"), ("instagram.com", "Social"), ("twitter.com", "Social"), ("x.com", "Social"), ("reddit.com", "Social"), ("linkedin.com", "Social"), ("tiktok.com", "Social"), ("snapchat.com", "Social"), ("discord.com", "Social"), ("pinterest.com", "Social"), ("telegram.org", "Social"), ("whatsapp.com", "Social"), ("tumblr.com", "Social"), ("threads.net", "Social"), ("bsky.app", "Social"), ("mastodon.social", "Social"),
    ("paypal.com", "Finance"), ("stripe.com", "Finance"), ("wise.com", "Finance"), ("revolut.com", "Finance"), ("coinbase.com", "Finance"), ("binance.com", "Finance"), ("kraken.com", "Finance"), ("chase.com", "Finance"), ("bankofamerica.com", "Finance"), ("wellsfargo.com", "Finance"), ("citi.com", "Finance"), ("hsbc.com", "Finance"), ("barclays.co.uk", "Finance"), ("americanexpress.com", "Finance"), ("capitalone.com", "Finance"), ("schwab.com", "Finance"), ("fidelity.com", "Finance"), ("vanguard.com", "Finance"), ("robinhood.com", "Finance"), ("venmo.com", "Finance"), ("cash.app", "Finance"), ("klarna.com", "Finance"), ("n26.com", "Finance"), ("monzo.com", "Finance"), ("payoneer.com", "Finance"), ("tradingview.com", "Finance"), ("intuit.com", "Finance"), ("mint.com", "Finance"),
    ("amazon.com", "Shopping"), ("ebay.com", "Shopping"), ("aliexpress.com", "Shopping"), ("etsy.com", "Shopping"), ("walmart.com", "Shopping"), ("target.com", "Shopping"), ("bestbuy.com", "Shopping"), ("shopify.com", "Shopping"), ("temu.com", "Shopping"), ("shein.com", "Shopping"), ("ikea.com", "Shopping"), ("zalando.com", "Shopping"), ("costco.com", "Shopping"), ("newegg.com", "Shopping"), ("noon.com", "Shopping"), ("jumia.com", "Shopping"), ("uber.com", "Travel"),
    ("github.com", "Developer"), ("gitlab.com", "Developer"), ("bitbucket.org", "Developer"), ("stackoverflow.com", "Developer"), ("npmjs.com", "Developer"), ("docker.com", "Developer"), ("vercel.com", "Developer"), ("netlify.com", "Developer"), ("cloudflare.com", "Developer"), ("digitalocean.com", "Developer"), ("hetzner.com", "Developer"), ("heroku.com", "Developer"), ("jetbrains.com", "Developer"), ("openai.com", "Developer"), ("anthropic.com", "Developer"), ("huggingface.co", "Developer"), ("pypi.org", "Developer"), ("crates.io", "Developer"), ("codepen.io", "Developer"), ("replit.com", "Developer"), ("supabase.com", "Developer"), ("firebase.google.com", "Developer"), ("sentry.io", "Developer"), ("postman.com", "Developer"), ("namecheap.com", "Developer"), ("godaddy.com", "Developer"), ("porkbun.com", "Developer"),
    ("steampowered.com", "Gaming"), ("steamcommunity.com", "Gaming"), ("epicgames.com", "Gaming"), ("riotgames.com", "Gaming"), ("leagueoflegends.com", "Gaming"), ("battle.net", "Gaming"), ("blizzard.com", "Gaming"), ("ea.com", "Gaming"), ("ubisoft.com", "Gaming"), ("xbox.com", "Gaming"), ("playstation.com", "Gaming"), ("nintendo.com", "Gaming"), ("twitch.tv", "Gaming"), ("roblox.com", "Gaming"), ("minecraft.net", "Gaming"), ("gog.com", "Gaming"), ("itch.io", "Gaming"), ("dpm.lol", "Gaming"), ("op.gg", "Gaming"), ("mobalytics.gg", "Gaming"), ("faceit.com", "Gaming"), ("curseforge.com", "Gaming"), ("nexusmods.com", "Gaming"),
    ("netflix.com", "Entertainment"), ("youtube.com", "Entertainment"), ("spotify.com", "Entertainment"), ("disneyplus.com", "Entertainment"), ("hulu.com", "Entertainment"), ("hbomax.com", "Entertainment"), ("max.com", "Entertainment"), ("primevideo.com", "Entertainment"), ("crunchyroll.com", "Entertainment"), ("soundcloud.com", "Entertainment"), ("deezer.com", "Entertainment"), ("plex.tv", "Entertainment"), ("imdb.com", "Entertainment"), ("trakt.tv", "Entertainment"), ("vimeo.com", "Entertainment"), ("apple.com", "Entertainment"), ("anilist.co", "Entertainment"), ("myanimelist.net", "Entertainment"), ("kick.com", "Entertainment"),
    ("slack.com", "Work"), ("zoom.us", "Work"), ("notion.so", "Work"), ("atlassian.com", "Work"), ("trello.com", "Work"), ("asana.com", "Work"), ("monday.com", "Work"), ("office.com", "Work"), ("microsoft.com", "Work"), ("salesforce.com", "Work"), ("figma.com", "Work"), ("canva.com", "Work"), ("miro.com", "Work"), ("airtable.com", "Work"), ("clickup.com", "Work"), ("adobe.com", "Work"), ("docusign.com", "Work"), ("upwork.com", "Work"), ("fiverr.com", "Work"),
    ("dropbox.com", "Cloud"), ("drive.google.com", "Cloud"), ("google.com", "Cloud"), ("onedrive.com", "Cloud"), ("mega.nz", "Cloud"), ("box.com", "Cloud"), ("backblaze.com", "Cloud"), ("aws.amazon.com", "Cloud"), ("azure.com", "Cloud"), ("wasabi.com", "Cloud"), ("pcloud.com", "Cloud"), ("tailscale.com", "Cloud"),
    ("booking.com", "Travel"), ("airbnb.com", "Travel"), ("expedia.com", "Travel"), ("tripadvisor.com", "Travel"), ("skyscanner.com", "Travel"), ("emirates.com", "Travel"), ("ryanair.com", "Travel"), ("lufthansa.com", "Travel"), ("delta.com", "Travel"), ("uber.com", "Travel"), ("lyft.com", "Travel"), ("kayak.com", "Travel"),
    ("coursera.org", "Education"), ("udemy.com", "Education"), ("edx.org", "Education"), ("khanacademy.org", "Education"), ("duolingo.com", "Education"), ("quizlet.com", "Education"), ("brilliant.org", "Education"), ("skillshare.com", "Education"), ("chegg.com", "Education"), ("academia.edu", "Education"), ("canvas.instructure.com", "Education"), ("blackboard.com", "Education"),
    ("nytimes.com", "News"), ("washingtonpost.com", "News"), ("bbc.com", "News"), ("bbc.co.uk", "News"), ("cnn.com", "News"), ("theguardian.com", "News"), ("medium.com", "News"), ("substack.com", "News"), ("bloomberg.com", "News"), ("wsj.com", "News"), ("economist.com", "News"),
    ("mychart.com", "Health"), ("webmd.com", "Health"), ("myfitnesspal.com", "Health"), ("strava.com", "Health"), ("fitbit.com", "Health"), ("garmin.com", "Health"), ("cvs.com", "Health"), ("walgreens.com", "Health"), ("zocdoc.com", "Health"),
    ("irs.gov", "Government"), ("usps.com", "Government"), ("ssa.gov", "Government"), ("login.gov", "Government"), ("gov.uk", "Government"), ("uscis.gov", "Government"), ("id.me", "Government"),
];

const KEYWORDS: &[(&str, &str)] = &[("bank", "Finance"), ("credit", "Finance"), ("pay", "Finance"), ("invest", "Finance"), ("crypto", "Finance"), ("wallet", "Finance"), ("insur", "Finance"), ("loan", "Finance"), ("tax", "Finance"),
    ("shop", "Shopping"), ("store", "Shopping"), ("market", "Shopping"), ("mail", "Email"), ("git", "Developer"), ("dev", "Developer"), ("api", "Developer"), ("server", "Developer"), ("host", "Developer"), ("code", "Developer"),
    ("game", "Gaming"), ("play", "Gaming"), ("stream", "Entertainment"), ("music", "Entertainment"), ("video", "Entertainment"), ("movie", "Entertainment"), ("anime", "Entertainment"),
    ("school", "Education"), ("univers", "Education"), ("course", "Education"), ("learn", "Education"), ("news", "News"), ("health", "Health"), ("clinic", "Health"), ("doctor", "Health"), ("fit", "Health"),
    ("flight", "Travel"), ("hotel", "Travel"), ("travel", "Travel"), ("airline", "Travel"), ("cloud", "Cloud"), ("drive", "Cloud"), ("storage", "Cloud"), ("gov", "Government"), ("office", "Work"), ("team", "Work"), ("jira", "Work"), ("social", "Social"), ("chat", "Social")];

fn field<'a>(i: &'a Item, l: &str) -> &'a str { i.fields.iter().find(|f| f.label == l).map(|f| f.value.as_str()).unwrap_or("") }

pub fn website(i: &Item) -> String {
    ["Website", "Online banking", "Endpoint", "URL"].iter().map(|l| field(i, l)).find(|v| !v.is_empty()).unwrap_or("").to_string()
}

/// The user's own category if set, else an automatic one.
pub fn of(i: &Item) -> String {
    if !i.category.is_empty() { return i.category.clone(); }
    match i.kind.as_str() {
        "card" | "bank" => return "Finance".into(),
        "ssh" | "api" => return "Developer".into(), // a Stripe key is a developer thing even though stripe.com is a finance site
        "wifi" => return "Network".into(),
        "identity" | "document" => return "Identity".into(),
        "note" => return "Notes".into(),
        _ => {}
    }
    let site = website(i);
    if let Some(host) = domain::host_of(&site).or_else(|| domain::host_of(&i.title)) {
        let reg = domain::etld1(&host);
        if let Some((_, c)) = DOMAINS.iter().find(|(d, _)| *d == host || *d == reg) { return (*c).into(); }
        if let Some((_, c)) = DOMAINS.iter().find(|(d, _)| host.ends_with(&format!(".{d}"))) { return (*c).into(); }
    }
    let text = format!("{} {}", i.title, site).to_lowercase();
    // a word of the title that is a known site name ("GitHub", "Netflix account")
    for w in text.split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() >= 4) {
        if let Some((_, c)) = DOMAINS.iter().find(|(d, _)| d.split('.').next() == Some(w)) { return (*c).into(); }
    }
    for (k, c) in KEYWORDS { if text.contains(k) { return (*c).into(); } }
    "Other".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Field;

    fn it(kind: &str, title: &str, site: &str) -> Item {
        Item { kind: kind.into(), title: title.into(), fields: vec![Field { label: "Website".into(), value: site.into(), kind: "text".into() }], ..Default::default() }
    }

    #[test]
    fn categorizes_by_type_domain_and_words() {
        assert_eq!(of(&it("card", "Visa", "")), "Finance");
        assert_eq!(of(&it("wifi", "Home", "")), "Network");
        assert_eq!(of(&it("api", "Stripe key", "https://api.stripe.com")), "Developer");
        assert_eq!(of(&it("login", "x", "https://accounts.google.com/signin")), "Cloud");
        assert_eq!(of(&it("login", "x", "https://www.paypal.com/login")), "Finance");
        assert_eq!(of(&it("login", "x", "https://old.reddit.com")), "Social");
        assert_eq!(of(&it("login", "GitHub", "")), "Developer");
        assert_eq!(of(&it("login", "My Netflix account", "")), "Entertainment");
        assert_eq!(of(&it("login", "Dentist clinic portal", "")), "Health");
        assert_eq!(of(&it("login", "Random", "https://unknown-shop.example")), "Shopping");
        assert_eq!(of(&it("login", "Zzz", "")), "Other");
        let mut m = it("login", "GitHub", "https://github.com");
        m.category = "Work".into();
        assert_eq!(of(&m), "Work", "the user's choice wins");
        assert!(ALL.contains(&"Other") && DOMAINS.iter().all(|(_, c)| ALL.contains(c)), "every table category is a known one");
    }
}
